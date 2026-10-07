const handler = require('../../../server');

module.exports = (req, res) => {
  const current = String(req.url || '/');
  if (current.startsWith('/api/admin')) req.url = current;
  else if (current.startsWith('/admin')) req.url = '/api' + current;
  else req.url = '/api/admin' + (current.startsWith('/') ? current : '/' + current);
  return handler(req, res);
};
