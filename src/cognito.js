// Email-and-password accounts through the Cognito user pool's public API, called straight from the
// browser (these operations need no AWS signature). Cognito emails the verification and password
// reset codes itself. Google and GitHub still go through the Hosted UI (src/auth.js).
const REGION = 'us-east-1';
const ENDPOINT = `https://cognito-idp.${REGION}.amazonaws.com/`;

export class CognitoError extends Error {
  constructor(type, message) {
    super(message);
    this.type = type;
  }
}

// Plain-English messages for the errors people actually hit.
const FRIENDLY = {
  UsernameExistsException: 'An account with this email already exists. Log in instead.',
  InvalidPasswordException: 'Use at least 8 characters with upper and lower case letters, a number and a symbol.',
  CodeMismatchException: 'That code isn’t right. Check the email and try again.',
  ExpiredCodeException: 'That code has expired. Send a new one.',
  UserNotConfirmedException: 'Confirm your email first. We’ve sent you a new code.',
  UserNotFoundException: 'Email or password is incorrect.',
  LimitExceededException: 'Too many attempts. Wait a few minutes and try again.',
  TooManyRequestsException: 'Too many attempts. Wait a few minutes and try again.',
  TooManyFailedAttemptsException: 'Too many attempts. Wait a few minutes and try again.',
  CodeDeliveryFailureException: 'We couldn’t send the code. Check the email address.',
  InvalidParameterException: 'Check the details and try again.',
};

function friendly(type, message) {
  if (type === 'NotAuthorizedException') {
    if (/attempts exceeded/i.test(message)) return 'Too many attempts. Wait a few minutes and try again.';
    if (/disabled/i.test(message)) return 'This account has been disabled. Contact support@lyrcloud.com.';
    if (/confirmed/i.test(message)) return 'This account is already confirmed. Log in instead.';
    return 'Email or password is incorrect.';
  }
  if (type === 'InvalidParameterException' && /phone/i.test(message)) return message;
  return FRIENDLY[type] || message || 'Something went wrong. Please try again.';
}

async function call(action, body) {
  let response;
  try {
    response = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/x-amz-json-1.1', 'x-amz-target': `AWSCognitoIdentityProviderService.${action}` },
      body: JSON.stringify(body),
    });
  } catch {
    throw new CognitoError('NetworkError', 'Can’t reach the sign-in service. Check your connection.');
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const type = String(data.__type || '').split('#').pop();
    throw new CognitoError(type, friendly(type, data.message || data.Message));
  }
  return data;
}

// Accounts are keyed by their email, lower-cased so "Ada@x.com" and "ada@x.com" are one account.
export const normalizeEmail = (email) => String(email || '').trim().toLowerCase();

export const signUp = (clientId, { email, password, name }) =>
  call('SignUp', {
    ClientId: clientId,
    Username: normalizeEmail(email),
    Password: password,
    UserAttributes: [{ Name: 'email', Value: normalizeEmail(email) }, ...(name ? [{ Name: 'name', Value: name }] : [])],
  });

export const confirmSignUp = (clientId, email, code) =>
  call('ConfirmSignUp', { ClientId: clientId, Username: normalizeEmail(email), ConfirmationCode: code.trim() });

export const resendCode = (clientId, email) => call('ResendConfirmationCode', { ClientId: clientId, Username: normalizeEmail(email) });

export const forgotPassword = (clientId, email) => call('ForgotPassword', { ClientId: clientId, Username: normalizeEmail(email) });

export const confirmForgotPassword = (clientId, email, code, password) =>
  call('ConfirmForgotPassword', { ClientId: clientId, Username: normalizeEmail(email), ConfirmationCode: code.trim(), Password: password });

// Returns Cognito's AuthenticationResult: { AccessToken, IdToken, RefreshToken, ExpiresIn }.
export async function signIn(clientId, email, password) {
  const data = await call('InitiateAuth', {
    ClientId: clientId,
    AuthFlow: 'USER_PASSWORD_AUTH',
    AuthParameters: { USERNAME: normalizeEmail(email), PASSWORD: password },
  });
  if (!data.AuthenticationResult) throw new CognitoError(data.ChallengeName || 'Challenge', 'This account needs a step this page doesn’t support yet. Contact support@lyrcloud.com.');
  return data.AuthenticationResult;
}

export async function refresh(clientId, refreshToken) {
  const data = await call('InitiateAuth', { ClientId: clientId, AuthFlow: 'REFRESH_TOKEN_AUTH', AuthParameters: { REFRESH_TOKEN: refreshToken } });
  return data.AuthenticationResult;
}

export const revoke = (clientId, refreshToken) => call('RevokeToken', { ClientId: clientId, Token: refreshToken }).catch(() => {});
