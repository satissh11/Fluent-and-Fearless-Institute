const handler = require('../server');

module.exports = (req, res) => {
  if (!req.url.startsWith('/api/')) req.url = '/api' + (req.url.startsWith('/') ? req.url : '/' + req.url);
  return handler(req, res);
};
