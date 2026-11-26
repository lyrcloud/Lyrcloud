// The Edge Functions router. Every <name>.dev.lyr address is an API Gateway custom domain mapped to one
// HTTP API whose only route sends here; this passes the request to the Lambda function lyrfn-<name>
// (which runs __lyrcloud/runtime.mjs) and returns what it answers.
import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import { FUNCTIONS_DOMAIN_DEFAULT, lambdaName, nameFromHost } from './rules.mjs';

const DOMAIN = process.env.FUNCTIONS_DOMAIN || FUNCTIONS_DOMAIN_DEFAULT;
export const lambda = new LambdaClient({});

const page = (statusCode, title, message) => ({
  statusCode,
  headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
  body: `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${title}</title><body style="font-family:system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 1rem;line-height:1.5"><h1>${title}</h1><p>${message}</p><p><a href="https://www.lyrcloud.com/developers/">Lyrcloud Edge Functions</a></p></body>`,
});

export const handler = async (event) => {
  const name = nameFromHost(event.requestContext?.domainName || event.headers?.host, DOMAIN);
  if (!name) return page(404, 'Not found', 'There’s no Lyrcloud function at this address.');
  let result;
  try {
    result = await lambda.send(new InvokeCommand({ FunctionName: lambdaName(name), Payload: Buffer.from(JSON.stringify(event)) }));
  } catch (err) {
    if (err.name === 'ResourceNotFoundException') return page(404, 'Not found', `There’s no function called ${name} yet.`);
    if (err.name === 'TooManyRequestsException') return page(503, 'Busy', 'This function is receiving too many requests or has been paused. Try again shortly.');
    if (err.name === 'RequestTooLargeException') return page(413, 'Too large', 'The request is larger than functions accept (6 MB).');
    console.error('Invoke failed', name, err);
    return page(502, 'Function unavailable', 'This function couldn’t be reached. Try again shortly.');
  }
  const text = Buffer.from(result.Payload || []).toString('utf8');
  if (result.FunctionError) {
    console.error('Function error', name, result.FunctionError, text.slice(0, 2000));
    const timedOut = /timed out/i.test(text);
    return page(timedOut ? 504 : 502, timedOut ? 'Timed out' : 'Function failed', timedOut
      ? 'This function took longer than its time limit to answer.'
      : 'This function stopped unexpectedly. Its owner can see why with <code>lyrcloud logs</code>.');
  }
  try {
    const answer = JSON.parse(text);
    if (answer && typeof answer.statusCode === 'number') return answer;
  } catch {
    // fall through
  }
  return page(502, 'Function failed', 'This function returned something that isn’t an HTTP response.');
};
