const DEFAULT_ORIGIN = 'https://rrcoi7071-ux.github.io';

function allowedOrigins() {
  return (process.env.APP_ORIGIN || DEFAULT_ORIGIN)
    .split(',')
    .map(value => value.trim().replace(/\/$/, ''))
    .filter(Boolean);
}

function applyCors(req, res) {
  const origin = String(req.headers.origin || '').replace(/\/$/, '');
  if (origin && allowedOrigins().includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store');
}

function originAllowed(req) {
  const origin = String(req.headers.origin || '').replace(/\/$/, '');
  if (!origin) return true;
  const host = String(req.headers.host || '');
  return origin === `https://${host}` || origin === `http://${host}` || allowedOrigins().includes(origin);
}

module.exports = { applyCors, originAllowed };
