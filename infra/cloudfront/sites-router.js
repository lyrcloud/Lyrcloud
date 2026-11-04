// CloudFront Function (cloudfront-js-2.0, viewer request) for Lyrcloud Projects at *.lyrcloud.app.
// The KeyValueStore maps a project name to its live deployment: "<projectId>/<deployId>|spa|static".
// "name.lyrcloud.app/about" becomes "/sites/<projectId>/<deployId>/about/index.html" in the sites
// bucket ("/index.html" for single-page apps). Each deployment has its own paths, so switching the
// key makes a new deployment live at once with nothing to invalidate.
// The DOMAIN placeholder below is filled in at deploy time (scripts/deploy-projects.sh).
import cf from 'cloudfront';

const kvs = cf.kvs();
const DOMAIN = '__DOMAIN__';

function respond(statusCode, statusDescription, headers) {
  return { statusCode, statusDescription, headers: headers || {} };
}

async function handler(event) {
  const request = event.request;
  const host = (request.headers.host && request.headers.host.value || '').toLowerCase();

  if (host === DOMAIN || host === 'www.' + DOMAIN) {
    return respond(302, 'Found', { location: { value: 'https://www.lyrcloud.com/' } });
  }
  const name = host.slice(0, -(DOMAIN.length + 1));
  if (!host.endsWith('.' + DOMAIN) || !name || name.indexOf('.') !== -1) {
    request.uri = '/_lyrcloud/404.html';
    return request;
  }

  let target;
  try {
    target = await kvs.get(name);
  } catch (err) {
    request.uri = '/_lyrcloud/404.html';
    return request;
  }
  const parts = target.split('|');
  const prefix = parts[0];
  const mode = parts[1];

  let uri = request.uri;
  // Never let "/.." or encoded tricks climb out of the deployment's folder.
  if (uri.indexOf('..') !== -1 || uri.indexOf('%2e') !== -1 || uri.indexOf('%2E') !== -1) uri = '/';
  const last = uri.slice(uri.lastIndexOf('/') + 1);
  if (uri.endsWith('/')) {
    uri += 'index.html';
  } else if (last.indexOf('.') === -1) {
    uri = mode === 'spa' ? '/index.html' : uri + '/index.html';
  }
  request.uri = '/sites/' + prefix + uri;
  return request;
}
