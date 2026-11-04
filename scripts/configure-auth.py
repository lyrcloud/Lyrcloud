#!/usr/bin/env python3
"""Configures the hand-made Lyrcloud sign-in setup for email-and-password accounts, verification codes,
welcome/update emails and text messages. Shows what it would change; pass --apply to change it.

    python3 scripts/configure-auth.py                     # report only
    python3 scripts/configure-auth.py --apply             # user pool, app client, SES identity, SMS type
    python3 scripts/configure-auth.py --apply --github-bridge https://xxxx.execute-api.us-east-1.amazonaws.com

What it does:
  * User pool: lets people sign up themselves, auto-verifies email with a 6-digit code (Lyrcloud-branded
    message), recovers accounts by verified email, and sends Cognito's emails through SES once the
    lyrcloud.com identity is verified (until then Cognito's own sender, limited to 50 emails a day).
  * App client: allows USER_PASSWORD_AUTH and REFRESH_TOKEN_AUTH for the sign-up form, and COGNITO as a provider.
  * SES: creates the lyrcloud.com domain identity if missing and prints the DKIM CNAMEs for Cloudflare.
  * SNS: makes texts Transactional and reports the SMS sandbox and spend limit.
  * --github-bridge: points the GitHubBridge identity provider at the bridge (keeps its client ID/secret).

UpdateUserPool and UpdateUserPoolClient reset every setting they aren't given, so this copies the
current settings and changes only the fields above. Credentials come from the usual AWS_* variables.
"""
import argparse
import json
import sys

try:
    import botocore.session as boto_session
except ImportError:  # the AWS CLI v1 on the phone vendors botocore
    import awscli.botocore.session as boto_session

REGION = 'us-east-1'
ACCOUNT_API_STACK = 'lyrcloud-account-api'
CLIENT_ID = '5h78n6dkjbhq92423lscfllj6t'
DOMAIN = 'lyrcloud.com'
COGNITO_FROM = 'Lyrcloud <no-reply@lyrcloud.com>'
GITHUB_PROVIDER = 'GitHubBridge'

VERIFY_SUBJECT = 'Your Lyrcloud verification code'
VERIFY_MESSAGE = """<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;font-size:15px;line-height:1.6;color:#1d1f23;max-width:520px">
<p style="font-size:20px;font-weight:700;color:#0369a1;margin:0 0 16px">Lyrcloud</p>
<p>Use this code to confirm your email address:</p>
<p style="font-size:30px;font-weight:700;letter-spacing:6px;margin:16px 0">{####}</p>
<p>It expires in 24 hours. If you didn't create a Lyrcloud account, you can ignore this email.</p>
</div>"""
SMS_MESSAGE = '{####} is your Lyrcloud verification code.'


def client(name):
    return boto_session.get_session().create_client(name, region_name=REGION)


def only_members(operation_client, operation, params):
    """Drops keys the operation doesn't accept (describe returns read-only fields too)."""
    members = operation_client.meta.service_model.operation_model(operation).input_shape.members
    return {key: value for key, value in params.items() if key in members}


def show_change(label, before, after):
    if before == after:
        print(f'  = {label}: unchanged')
        return False
    print(f'  ~ {label}: {json.dumps(before, default=str)} -> {json.dumps(after, default=str)}')
    return True


def configure_ses(apply):
    print('\nSES (welcome and update emails, Cognito verification emails)')
    ses = client('sesv2')
    try:
        identity = ses.get_email_identity(EmailIdentity=DOMAIN)
    except ses.exceptions.NotFoundException:
        print(f'  + domain identity {DOMAIN} doesn\'t exist')
        if not apply:
            return False
        ses.create_email_identity(EmailIdentity=DOMAIN)
        identity = ses.get_email_identity(EmailIdentity=DOMAIN)
    verified = identity.get('VerifiedForSendingStatus', False)
    dkim = identity.get('DkimAttributes', {})
    print(f'  {DOMAIN}: verified for sending = {verified}, DKIM = {dkim.get("Status")}')
    if not verified:
        print('  Add these CNAME records in Cloudflare (DNS only, not proxied):')
        for token in dkim.get('Tokens', []):
            print(f'    {token}._domainkey.{DOMAIN}  CNAME  {token}.dkim.amazonses.com')
    account = ses.get_account()
    print(f'  account: production access = {account.get("ProductionAccessEnabled")}, '
          f'sending enabled = {account.get("SendingEnabled")}, quota = {account.get("SendQuota", {}).get("Max24HourSend")}/day')
    if not account.get('ProductionAccessEnabled'):
        print('  SES is in the sandbox: it only delivers to verified addresses until AWS grants production access.')
    return verified


def configure_pool(apply, ses_ready):
    print(f'\nUser pool {USER_POOL_ID}')
    idp = client('cognito-idp')
    pool = idp.describe_user_pool(UserPoolId=USER_POOL_ID)['UserPool']
    print(f'  sign-in by: UsernameAttributes={pool.get("UsernameAttributes")}, AliasAttributes={pool.get("AliasAttributes")}')

    params = only_members(idp, 'UpdateUserPool', dict(pool))
    params['UserPoolId'] = USER_POOL_ID
    # AdminCreateUserConfig comes back with a deprecated field the update rejects.
    admin_create = {k: v for k, v in pool.get('AdminCreateUserConfig', {}).items() if k != 'UnusedAccountValidityDays'}
    wanted = {
        'AdminCreateUserConfig': {**admin_create, 'AllowAdminCreateUserOnly': False},
        'AutoVerifiedAttributes': sorted(set(pool.get('AutoVerifiedAttributes', [])) | {'email'}),
        'VerificationMessageTemplate': {
            **pool.get('VerificationMessageTemplate', {}),
            'DefaultEmailOption': 'CONFIRM_WITH_CODE',
            'EmailSubject': VERIFY_SUBJECT,
            'EmailMessage': VERIFY_MESSAGE,
            'SmsMessage': SMS_MESSAGE,
        },
    }
    # Keep existing recovery options; only make sure a verified email can recover the account.
    recovery = pool.get('AccountRecoverySetting', {}).get('RecoveryMechanisms', [])
    if not any(item['Name'] == 'verified_email' for item in recovery):
        wanted['AccountRecoverySetting'] = {'RecoveryMechanisms': [{'Priority': 1, 'Name': 'verified_email'}]}
    # The older top-level copies of the message override the template if left in place.
    for legacy in ('EmailVerificationMessage', 'EmailVerificationSubject', 'SmsVerificationMessage'):
        params.pop(legacy, None)
    if ses_ready:
        wanted['EmailConfiguration'] = {
            'EmailSendingAccount': 'DEVELOPER',
            'SourceArn': f'arn:aws:ses:{REGION}:{account_id()}:identity/{DOMAIN}',
            'From': COGNITO_FROM,
        }
    else:
        print('  (Cognito keeps its own email sender until the SES identity is verified)')

    current = {**pool, 'AdminCreateUserConfig': admin_create}
    changed = False
    for key, value in wanted.items():
        changed |= show_change(key, current.get(key), value)
        params[key] = value
    if changed and apply:
        idp.update_user_pool(**params)
        print('  updated')

    print(f'\nApp client {CLIENT_ID}')
    app = idp.describe_user_pool_client(UserPoolId=USER_POOL_ID, ClientId=CLIENT_ID)['UserPoolClient']
    if app.get('ClientSecret'):
        sys.exit('  The app client has a secret, so the browser can\'t call SignUp/InitiateAuth. Stopping.')
    app_params = only_members(idp, 'UpdateUserPoolClient', dict(app))
    flows = sorted(set(app.get('ExplicitAuthFlows', [])) | {'ALLOW_USER_PASSWORD_AUTH', 'ALLOW_REFRESH_TOKEN_AUTH', 'ALLOW_USER_SRP_AUTH'})
    providers = sorted(set(app.get('SupportedIdentityProviders', [])) | {'COGNITO'})
    changed = show_change('ExplicitAuthFlows', app.get('ExplicitAuthFlows'), flows)
    changed |= show_change('SupportedIdentityProviders', app.get('SupportedIdentityProviders'), providers)
    changed |= show_change('PreventUserExistenceErrors', app.get('PreventUserExistenceErrors'), 'ENABLED')
    app_params.update(ExplicitAuthFlows=flows, SupportedIdentityProviders=providers, PreventUserExistenceErrors='ENABLED')
    if changed and apply:
        idp.update_user_pool_client(**app_params)
        print('  updated')


def configure_sms(apply):
    print('\nSNS text messages (mobile verification codes)')
    sns = client('sns')
    attrs = sns.get_sms_attributes(attributes=['DefaultSMSType', 'MonthlySpendLimit']).get('attributes', {})
    if show_change('DefaultSMSType', attrs.get('DefaultSMSType'), 'Transactional') and apply:
        sns.set_sms_attributes(attributes={'DefaultSMSType': 'Transactional'})
        print('  updated')
    print(f'  monthly spend limit: ${attrs.get("MonthlySpendLimit", "1")} (AWS default is $1; raise it in the SNS console)')
    try:
        sandbox = sns.get_sms_sandbox_account_status()['IsInSandbox']
        print(f'  SMS sandbox: {sandbox}' + (' — texts only reach numbers verified in the SNS console until you request production access' if sandbox else ''))
    except Exception as err:  # older botocore
        print(f'  SMS sandbox status unavailable: {err}')


BRIDGE_SECRET = 'lyrcloud/github-bridge'


def configure_github(apply, bridge, add_client_secret=False):
    """Points GitHubBridge at the bridge. Cognito authenticates to the bridge with bridgeClientId and
    bridgeClientSecret from the bridge's secret; the secret gets a bridgeClientSecret if it lacks one."""
    print(f'\nIdentity provider {GITHUB_PROVIDER} -> {bridge}')
    secrets = client('secretsmanager')
    secret = json.loads(secrets.get_secret_value(SecretId=BRIDGE_SECRET)['SecretString'])
    if not secret.get('bridgeClientSecret'):
        print(f'  {"+" if add_client_secret else "-"} {BRIDGE_SECRET}: no bridgeClientSecret'
              + ('' if add_client_secret else ' (the bridge accepts any client secret; --add-bridge-client-secret adds one)'))
        if apply and add_client_secret:
            import secrets as random_secrets
            secret['bridgeClientSecret'] = random_secrets.token_urlsafe(32)
            secrets.put_secret_value(SecretId=BRIDGE_SECRET, SecretString=json.dumps(secret))
            print('  updated (the bridge picks it up on its next cold start)')

    idp = client('cognito-idp')
    provider = idp.describe_identity_provider(UserPoolId=USER_POOL_ID, ProviderName=GITHUB_PROVIDER)['IdentityProvider']
    details = dict(provider['ProviderDetails'])
    wanted = {
        'client_id': secret['bridgeClientId'],
        'oidc_issuer': bridge,
        'authorize_url': f'{bridge}/authorize',
        'token_url': f'{bridge}/token',
        'attributes_url': f'{bridge}/userinfo',
        'jwks_uri': f'{bridge}/.well-known/jwks.json',
        'attributes_request_method': 'GET',
        'authorize_scopes': 'openid email profile',
    }
    changed = False
    for key, value in wanted.items():
        changed |= show_change(key, details.get(key), value)
    if secret.get('bridgeClientSecret') and details.get('client_secret') != secret['bridgeClientSecret']:
        print('  ~ client_secret: set to the bridge secret\'s bridgeClientSecret')
        wanted['client_secret'] = secret['bridgeClientSecret']
        changed = True
    details.update(wanted)
    # Cognito adds this itself and rejects it on update.
    details.pop('attributes_url_add_attributes', None)
    mapping = {**provider.get('AttributeMapping', {})}
    for attribute, claim in {'email': 'email', 'email_verified': 'email_verified', 'name': 'name', 'picture': 'picture', 'username': 'sub'}.items():
        mapping.setdefault(attribute, claim)
    changed |= show_change('AttributeMapping', provider.get('AttributeMapping'), mapping)
    if changed and apply:
        idp.update_identity_provider(UserPoolId=USER_POOL_ID, ProviderName=GITHUB_PROVIDER, ProviderDetails=details, AttributeMapping=mapping)
        print('  updated')
    print(f'  GitHub OAuth app "Authorization callback URL" must be: {bridge}/callback')


_account = None
USER_POOL_ID = None


def find_user_pool():
    """The pool the account API's JWT authorizer trusts, from that stack's UserPoolId parameter."""
    stack = client('cloudformation').describe_stacks(StackName=ACCOUNT_API_STACK)['Stacks'][0]
    params = {p['ParameterKey']: p['ParameterValue'] for p in stack['Parameters']}
    if params.get('UserPoolClientId') != CLIENT_ID:
        sys.exit(f'{ACCOUNT_API_STACK} uses app client {params.get("UserPoolClientId")}, not {CLIENT_ID} from src/auth.js. Stopping.')
    return params['UserPoolId']


def account_id():
    global _account
    _account = _account or client('sts').get_caller_identity()['Account']
    return _account


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--apply', action='store_true', help='make the changes (default: report only)')
    parser.add_argument('--add-bridge-client-secret', action='store_true', help='also make Cognito and the bridge share a client secret')
    parser.add_argument('--github-bridge', help='the GitHub bridge URL (BridgeApiBaseUrl output of the lyrcloud-github-bridge stack)')
    args = parser.parse_args()
    global USER_POOL_ID
    USER_POOL_ID = find_user_pool()
    print(f'Account {account_id()}, user pool {USER_POOL_ID} — {"APPLYING CHANGES" if args.apply else "report only, nothing changes (pass --apply)"}')
    ses_ready = configure_ses(args.apply)
    configure_pool(args.apply, ses_ready)
    configure_sms(args.apply)
    if args.github_bridge:
        configure_github(args.apply, args.github_bridge.rstrip('/'), args.add_bridge_client_secret)


if __name__ == '__main__':
    main()
