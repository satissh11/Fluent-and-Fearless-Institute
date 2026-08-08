const handler = require('../../../server');

module.exports = (req, res) => {
  if (!req.url.startsWith('/api/')) req.url = '/api/admin/login' + (req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '');
  return handler(req, res);
};
