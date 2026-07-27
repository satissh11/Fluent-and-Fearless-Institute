const http = require('http');
const https = require('https');
const tls = require('tls');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 5181;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'Bittu_sir@932';
const RAZORPAY_KEY_ID = process.env.RAZORPAY_KEY_ID || '';
const RAZORPAY_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET || '';
const RAZORPAY_COMPANY = process.env.RAZORPAY_COMPANY || 'Fluent & Fearless';
const VISITOR_REPORT_EMAIL = process.env.VISITOR_REPORT_EMAIL || '';
const SMTP_HOST = process.env.SMTP_HOST || '';
const SMTP_PORT = Number(process.env.SMTP_PORT || 465);
const SMTP_USER = process.env.SMTP_USER || '';
const SMTP_PASS = process.env.SMTP_PASS || '';
const VISITOR_REPORT_WHATSAPP_NUMBER = process.env.VISITOR_REPORT_WHATSAPP_NUMBER || '919229328115';
const SITE_URL = (process.env.SITE_URL || ('http://localhost:' + PORT)).replace(/\/$/, '');
const ROOT = path.resolve(__dirname);
const DATA_ROOT = process.env.VERCEL ? path.join('/tmp', 'fearless-data') : ROOT;
const DB_PATH = path.join(DATA_ROOT, 'portal-db.json');
const SEED_DB_PATH = path.join(ROOT, 'portal-db.json');
const UPLOAD_DIR = path.join(DATA_ROOT, 'uploads');
const REPORT_DIR = path.join(DATA_ROOT, 'reports');
const adminTokens = new Set();
const studentSessions = new Map();

function defaultDb() {
  return { subscriptions: [], students: [], reviews: [], gallery: [], pages: {}, pageImages: {}, visitors: [], contacts: [], reportState: {} };
}

function readDb() {
  if (!fs.existsSync(DATA_ROOT)) fs.mkdirSync(DATA_ROOT, { recursive: true });
  if (!fs.existsSync(DB_PATH)) {
    if (fs.existsSync(SEED_DB_PATH)) fs.copyFileSync(SEED_DB_PATH, DB_PATH);
    else fs.writeFileSync(DB_PATH, JSON.stringify(defaultDb(), null, 2));
  }
  const db = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
  db.subscriptions = db.subscriptions || [];
  db.students = db.students || [];
  db.reviews = db.reviews || [];
  db.gallery = db.gallery || [];
  db.pages = db.pages || {};
  db.pageImages = db.pageImages || {};
  db.visitors = db.visitors || [];
  db.contacts = db.contacts || [];
  db.reportState = db.reportState || {};
  return db;
}

function writeDb(db) {
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
}

function normalizeIdentifier(value) {
  return String(value || '').trim().toLowerCase();
}

function send(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 12 * 1024 * 1024) req.destroy();
    });
    req.on('end', () => {
      try { resolve(body ? JSON.parse(body) : {}); } catch (error) { reject(error); }
    });
  });
}

function makeToken() {
  return crypto.randomBytes(24).toString('hex');
}

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.pbkdf2Sync(String(password), salt, 120000, 32, 'sha256').toString('hex');
  return { salt, hash };
}

function verifyPassword(password, saved) {
  const check = hashPassword(password, saved.salt);
  return crypto.timingSafeEqual(Buffer.from(check.hash), Buffer.from(saved.hash));
}

function razorpayRequest(method, apiPath, payload) {
  return new Promise((resolve, reject) => {
    if (!RAZORPAY_KEY_ID || !RAZORPAY_KEY_SECRET) {
      reject(new Error('Razorpay keys not configured'));
      return;
    }

    const body = payload ? JSON.stringify(payload) : '';
    const req = https.request({
      hostname: 'api.razorpay.com',
      path: apiPath,
      method,
      auth: RAZORPAY_KEY_ID + ':' + RAZORPAY_KEY_SECRET,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      }
    }, response => {
      let data = '';
      response.on('data', chunk => { data += chunk; });
      response.on('end', () => {
        let parsed = {};
        try { parsed = data ? JSON.parse(data) : {}; } catch (error) { parsed = { error: data }; }
        if (response.statusCode >= 200 && response.statusCode < 300) resolve(parsed);
        else reject(new Error(parsed.error?.description || parsed.error || 'Razorpay request failed'));
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function verifyRazorpaySignature(orderId, paymentId, signature) {
  const expected = crypto
    .createHmac('sha256', RAZORPAY_KEY_SECRET)
    .update(orderId + '|' + paymentId)
    .digest('hex');
  const received = String(signature || '');
  return received.length === expected.length && crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(received));
}

function isAdmin(req) {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  return adminTokens.has(token);
}

function getStudent(req) {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  return studentSessions.get(token);
}

function findActiveSubscription(db, identifier) {
  return db.subscriptions.find(item => item.identifier === identifier && item.status === 'active');
}

function makeId(prefix) {
  return prefix + '_' + Date.now().toString(36) + '_' + crypto.randomBytes(3).toString('hex');
}

function cleanText(value, fallback = '') {
  return String(value || fallback).trim();
}

function getClientIp(req) {
  const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return forwarded || req.socket.remoteAddress || 'unknown';
}

function trackVisit(req, page) {
  try {
    const db = readDb();
    db.visitors.push({
      id: makeId('visit'),
      ip: getClientIp(req),
      browser: req.headers['user-agent'] || 'unknown',
      page,
      referrer: req.headers.referer || '',
      visitedAt: new Date().toISOString()
    });
    if (db.visitors.length > 10000) db.visitors = db.visitors.slice(-10000);
    writeDb(db);
  } catch (error) {
    console.warn('Visitor tracking failed:', error.message);
  }
}

function getVisitorsForLastDays(db, days = 7) {
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  return (db.visitors || [])
    .filter(item => new Date(item.visitedAt).getTime() >= cutoff)
    .sort((a, b) => new Date(b.visitedAt) - new Date(a.visitedAt));
}

function htmlEscape(value) {
  return String(value || '').replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
}

function getVisitorReportWhatsAppLink(report) {
  if (!VISITOR_REPORT_WHATSAPP_NUMBER || !report?.filename) return '';
  const reportUrl = SITE_URL + '/reports/' + encodeURIComponent(report.filename);
  const message = 'Weekly visitor report for Fluent & Fearless is ready. Total visits: ' + report.count + '. Download: ' + reportUrl;
  return 'https://wa.me/' + VISITOR_REPORT_WHATSAPP_NUMBER + '?text=' + encodeURIComponent(message);
}

function generateVisitorReport(days = 7) {
  const db = readDb();
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const contacts = (db.contacts || [])
    .filter(item => new Date(item.submittedAt).getTime() >= cutoff)
    .sort((a, b) => new Date(b.submittedAt) - new Date(a.submittedAt));
  if (!fs.existsSync(REPORT_DIR)) fs.mkdirSync(REPORT_DIR, { recursive: true });
  const filename = 'contact-report-' + new Date().toISOString().slice(0, 10) + '.xls';
  const filePath = path.join(REPORT_DIR, filename);
  const rows = contacts.map(item =>
    '<tr><td>' + htmlEscape(item.name) + '</td><td>' + htmlEscape(item.email) + '</td><td>' +
    htmlEscape(new Date(item.submittedAt).toLocaleString('en-IN')) + '</td><td>' +
    htmlEscape(item.page || 'contact.html') + '</td></tr>'
  ).join('');
  const html = '<html><head><meta charset="utf-8"></head><body>' +
    '<h2>Fluent &amp; Fearless &#8212; Weekly Contact Leads Report</h2>' +
    '<p>Period: Last 7 days | Total Inquiries: ' + contacts.length + '</p>' +
    '<table border="1" cellpadding="6" cellspacing="0">' +
    '<thead><tr><th>Name</th><th>Email</th><th>Date &amp; Time</th><th>Page</th></tr></thead>' +
    '<tbody>' + rows + '</tbody></table></body></html>';
  fs.writeFileSync(filePath, html, 'utf8');
  return { filePath, filename, count: contacts.length };
}

function smtpCommand(socket, command) {
  return new Promise((resolve, reject) => {
    let data = '';
    const onData = chunk => {
      data += chunk.toString();
      if (/\r?\n[0-9]{3} /.test(data) || /^[0-9]{3} /.test(data)) {
        socket.off('data', onData);
        if (/^[45]/m.test(data)) reject(new Error(data.trim()));
        else resolve(data);
      }
    };
    socket.on('data', onData);
    if (command) socket.write(command + '\r\n');
  });
}

async function sendVisitorReportEmail(report) {
  if (!VISITOR_REPORT_EMAIL || !SMTP_HOST || !SMTP_USER || !SMTP_PASS) return false;
  const socket = tls.connect({ host: SMTP_HOST, port: SMTP_PORT, servername: SMTP_HOST });
  await new Promise((resolve, reject) => { socket.once('secureConnect', resolve); socket.once('error', reject); });
  await smtpCommand(socket);
  await smtpCommand(socket, 'EHLO fluent-fearless.local');
  await smtpCommand(socket, 'AUTH LOGIN');
  await smtpCommand(socket, Buffer.from(SMTP_USER).toString('base64'));
  await smtpCommand(socket, Buffer.from(SMTP_PASS).toString('base64'));
  await smtpCommand(socket, 'MAIL FROM:<' + SMTP_USER + '>');
  await smtpCommand(socket, 'RCPT TO:<' + VISITOR_REPORT_EMAIL + '>');
  await smtpCommand(socket, 'DATA');
  const boundary = 'ff-report-' + Date.now();
  const attachment = fs.readFileSync(report.filePath).toString('base64').replace(/(.{76})/g, '$1\r\n');
  const message = [
    'From: ' + SMTP_USER,
    'To: ' + VISITOR_REPORT_EMAIL,
    'Subject: Weekly Visitor Report - Fluent & Fearless',
    'MIME-Version: 1.0',
    'Content-Type: multipart/mixed; boundary="' + boundary + '"',
    '',
    '--' + boundary,
    'Content-Type: text/plain; charset=utf-8',
    '',
    'Weekly visitor report attached. Total visits in last 7 days: ' + report.count,
    '',
    '--' + boundary,
    'Content-Type: application/vnd.ms-excel; name="' + report.filename + '"',
    'Content-Disposition: attachment; filename="' + report.filename + '"',
    'Content-Transfer-Encoding: base64',
    '',
    attachment,
    '--' + boundary + '--',
    '.'
  ].join('\r\n');
  await smtpCommand(socket, message);
  await smtpCommand(socket, 'QUIT');
  socket.end();
  return true;
}

async function runWeeklyVisitorReportIfDue(force = false) {
  const db = readDb();
  const last = db.reportState.lastWeeklyVisitorReportAt ? new Date(db.reportState.lastWeeklyVisitorReportAt).getTime() : 0;
  const due = force || Date.now() - last >= 7 * 24 * 60 * 60 * 1000;
  if (!due) return null;
  const report = generateVisitorReport(7);
  let emailed = false;
  try { emailed = await sendVisitorReportEmail(report); } catch (error) { report.emailError = error.message; }
  const latest = readDb();
  latest.reportState = latest.reportState || {};
  latest.reportState.lastWeeklyVisitorReportAt = new Date().toISOString();
  latest.reportState.lastWeeklyVisitorReportFile = report.filename;
  latest.reportState.lastWeeklyVisitorReportEmailed = emailed;
  latest.reportState.lastWeeklyVisitorReportError = report.emailError || '';
  latest.reportState.lastWeeklyVisitorReportWhatsAppLink = getVisitorReportWhatsAppLink(report);
  writeDb(latest);
  return { filename: report.filename, count: report.count, emailed, emailError: report.emailError || '', whatsAppLink: getVisitorReportWhatsAppLink(report) };
}

function saveUploadedDataUrl(dataUrl, prefix = 'image') {
  const match = String(dataUrl || '').match(/^data:(image\/(png|jpeg|jpg|webp|gif));base64,(.+)$/);
  if (!match) throw new Error('Valid image file required');
  const ext = match[2] === 'jpeg' ? 'jpg' : match[2];
  const bytes = Buffer.from(match[3], 'base64');
  if (!bytes.length) throw new Error('Empty image file');
  if (bytes.length > 6 * 1024 * 1024) throw new Error('Image must be under 6MB');
  if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  const safePrefix = String(prefix || 'image').replace(/[^a-z0-9_-]/gi, '-').toLowerCase();
  const filename = safePrefix + '-' + Date.now().toString(36) + '-' + crypto.randomBytes(3).toString('hex') + '.' + ext;
  fs.writeFileSync(path.join(UPLOAD_DIR, filename), bytes);
  return '/uploads/' + filename;
}

async function handleApi(req, res) {
  try {
    if (req.method === 'POST' && req.url === '/api/admin/login') {
      const body = await readBody(req);
      if (body.password !== ADMIN_PASSWORD) return send(res, 401, { error: 'Wrong admin password' });
      const token = makeToken();
      adminTokens.add(token);
      return send(res, 200, { token });
    }

    if (req.url.startsWith('/api/admin/subscriptions')) {
      if (!isAdmin(req)) return send(res, 401, { error: 'Admin login required' });
      const db = readDb();
      if (req.method === 'GET') return send(res, 200, { subscriptions: db.subscriptions, students: db.students.map(s => ({ identifier: s.identifier, name: s.name, createdAt: s.createdAt })) });
      if (req.method === 'POST') {
        const body = await readBody(req);
        const identifier = normalizeIdentifier(body.identifier);
        if (!identifier) return send(res, 400, { error: 'Email or phone required' });
        let subscription = db.subscriptions.find(item => item.identifier === identifier);
        if (!subscription) {
          subscription = { identifier, plan: body.plan || 'Standard Plan', status: 'active', source: 'admin', createdAt: new Date().toISOString() };
          db.subscriptions.push(subscription);
        } else {
          subscription.plan = body.plan || subscription.plan;
          subscription.status = 'active';
          subscription.updatedAt = new Date().toISOString();
        }
        writeDb(db);
        return send(res, 200, { ok: true, subscription });
      }
      if (req.method === 'DELETE') {
        const identifier = normalizeIdentifier(new URL(req.url, 'http://localhost').searchParams.get('identifier'));
        if (!identifier) return send(res, 400, { error: 'Email or phone required' });
        const before = db.subscriptions.length;
        db.subscriptions = db.subscriptions.filter(item => item.identifier !== identifier);
        writeDb(db);
        return send(res, 200, { ok: true, removed: before - db.subscriptions.length });
      }
    }

    if (req.method === 'POST' && req.url === '/api/razorpay/order') {
      const body = await readBody(req);
      const amount = Math.max(1, Math.round(Number(body.amount || 0) * 100));
      const plan = cleanText(body.plan, 'Online Plan');
      const identifier = normalizeIdentifier(body.identifier);
      if (!identifier) return send(res, 400, { error: 'Email or phone required' });
      if (!RAZORPAY_KEY_ID || !RAZORPAY_KEY_SECRET) return send(res, 500, { error: 'Razorpay keys not configured' });

      const order = await razorpayRequest('POST', '/v1/orders', {
        amount,
        currency: 'INR',
        receipt: makeId('receipt').slice(0, 40),
        notes: { plan, identifier }
      });
      return send(res, 200, { key: RAZORPAY_KEY_ID, order, company: RAZORPAY_COMPANY });
    }

    if (req.method === 'POST' && req.url === '/api/razorpay/verify') {
      const body = await readBody(req);
      const identifier = normalizeIdentifier(body.identifier);
      if (!identifier) return send(res, 400, { error: 'Email or phone required' });
      if (!verifyRazorpaySignature(body.razorpay_order_id, body.razorpay_payment_id, body.razorpay_signature)) {
        return send(res, 400, { error: 'Payment verification failed' });
      }

      const db = readDb();
      let subscription = db.subscriptions.find(item => item.identifier === identifier);
      const paymentInfo = {
        paymentId: cleanText(body.razorpay_payment_id),
        orderId: cleanText(body.razorpay_order_id),
        verifiedAt: new Date().toISOString()
      };
      if (!subscription) {
        subscription = {
          identifier,
          plan: body.plan || 'Online Plan',
          status: 'active',
          source: 'razorpay',
          amount: Number(body.amount || 0),
          payment: paymentInfo,
          createdAt: new Date().toISOString()
        };
        db.subscriptions.push(subscription);
      } else {
        subscription.status = 'active';
        subscription.plan = body.plan || subscription.plan;
        subscription.amount = Number(body.amount || subscription.amount || 0);
        subscription.source = 'razorpay';
        subscription.payment = paymentInfo;
        subscription.updatedAt = new Date().toISOString();
      }
      writeDb(db);
      return send(res, 200, { ok: true, subscription });
    }
    if (req.method === 'POST' && req.url === '/api/subscriptions/paid') {
      return send(res, 410, { error: 'Use Razorpay checkout for paid subscriptions' });
    }

    if (req.method === 'GET' && req.url === '/api/reviews') {
      const db = readDb();
      return send(res, 200, { reviews: db.reviews.filter(item => item.status !== 'hidden').sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)) });
    }

    // Public: submit contact form — saves name, email, date, page
    if (req.method === 'POST' && req.url === '/api/contact') {
      const body = await readBody(req);
      const name  = cleanText(body.name);
      const email = normalizeIdentifier(body.email);
      const message = cleanText(body.message);
      const page  = cleanText(body.page, 'contact.html');
      if (!name || name.length < 2) return send(res, 400, { error: 'Name is required.' });
      if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return send(res, 400, { error: 'A valid email address is required.' });
      if (!message) return send(res, 400, { error: 'Message is required.' });
      const db = readDb();
      db.contacts.push({
        id: makeId('contact'),
        name,
        email,
        message,
        page,
        submittedAt: new Date().toISOString()
      });
      writeDb(db);
      return send(res, 200, { ok: true });
    }

    // Admin: get all contact leads
    if (req.method === 'GET' && req.url.startsWith('/api/admin/contacts')) {
      if (!isAdmin(req)) return send(res, 401, { error: 'Admin login required' });
      const db = readDb();
      const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
      const params = new URL(req.url, 'http://localhost').searchParams;
      const days = Math.min(90, Math.max(1, Number(params.get('days') || 7)));
      const dayCutoff = Date.now() - days * 24 * 60 * 60 * 1000;
      const contacts = (db.contacts || [])
        .filter(item => new Date(item.submittedAt).getTime() >= dayCutoff)
        .sort((a, b) => new Date(b.submittedAt) - new Date(a.submittedAt));
      return send(res, 200, { contacts, total: contacts.length, lastReport: db.reportState || {} });
    }

    if (req.method === 'POST' && req.url === '/api/reviews') {
      const body = await readBody(req);
      const name = cleanText(body.name, 'Student');
      const email = normalizeIdentifier(body.email);
      const text = cleanText(body.text);
      // Validate real email format
      if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return send(res, 400, { error: 'A valid email address is required to post a review.' });
      if (!name || name.length < 2) return send(res, 400, { error: 'Your name is required.' });
      if (!text || text.length < 10) return send(res, 400, { error: 'Please write at least 10 characters in your review.' });
      const db = readDb();
      // One review per email address
      const alreadyReviewed = db.reviews.some(item => item.email && item.email.toLowerCase() === email);
      if (alreadyReviewed) return send(res, 409, { error: 'A review from this email address already exists. Each email can only submit one review.' });
      const review = {
        id: makeId('review'),
        name,
        email,
        text,
        rating: Math.min(5, Math.max(1, Number(body.rating || 5))),
        source: 'public',
        verified: false,
        status: 'published',
        createdAt: new Date().toISOString()
      };
      db.reviews.unshift(review);
      writeDb(db);
      return send(res, 200, { ok: true, review });
    }

    if (req.method === 'GET' && req.url === '/api/gallery') {
      const db = readDb();
      return send(res, 200, { gallery: db.gallery.filter(item => item.status !== 'hidden').sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)) });
    }

    if (req.method === 'GET' && req.url === '/api/pages') {
      const db = readDb();
      return send(res, 200, { pages: db.pages });
    }

    if (req.method === 'GET' && req.url === '/api/page-images') {
      const db = readDb();
      return send(res, 200, { pageImages: db.pageImages });
    }

    if (req.url.startsWith('/api/admin/visitors')) {
      if (!isAdmin(req)) return send(res, 401, { error: 'Admin login required' });
      const db = readDb();
      const params = new URL(req.url, 'http://localhost').searchParams;
      const days = Math.min(7, Math.max(1, Number(params.get('days') || 7)));
      const page = cleanText(params.get('page'));
      let visitors = getVisitorsForLastDays(db, days);
      if (page) visitors = visitors.filter(item => item.page.toLowerCase().includes(page.toLowerCase()));
      return send(res, 200, { visitors, total: visitors.length, lastReport: db.reportState || {} });
    }

    if (req.method === 'POST' && req.url === '/api/admin/visitor-report/send-now') {
      if (!isAdmin(req)) return send(res, 401, { error: 'Admin login required' });
      const report = await runWeeklyVisitorReportIfDue(true);
      return send(res, 200, { ok: true, report });
    }

    // Vercel weekly cron endpoint — called every Monday 9 AM via vercel.json crons
    if (req.method === 'GET' && req.url === '/api/admin/visitor-report/weekly-cron') {
      const report = await runWeeklyVisitorReportIfDue(false);
      return send(res, 200, { ok: true, ran: !!report, report });
    }
    if (req.url === '/api/admin/content') {
      if (!isAdmin(req)) return send(res, 401, { error: 'Admin login required' });
      const db = readDb();
      if (req.method === 'GET') return send(res, 200, { reviews: db.reviews, gallery: db.gallery, pages: db.pages });
    }

    if (req.url.startsWith('/api/admin/reviews')) {
      if (!isAdmin(req)) return send(res, 401, { error: 'Admin login required' });
      const db = readDb();
      if (req.method === 'POST') {
        const body = await readBody(req);
        const review = {
          id: makeId('review'),
          name: cleanText(body.name, 'Student'),
          text: cleanText(body.text),
          rating: Math.min(5, Math.max(1, Number(body.rating || 5))),
          source: 'admin',
          status: 'published',
          createdAt: new Date().toISOString()
        };
        if (!review.text) return send(res, 400, { error: 'Review text required' });
        db.reviews.unshift(review);
        writeDb(db);
        return send(res, 200, { ok: true, review });
      }
      if (req.method === 'DELETE') {
        const id = new URL(req.url, 'http://localhost').searchParams.get('id');
        db.reviews = db.reviews.filter(item => item.id !== id);
        writeDb(db);
        return send(res, 200, { ok: true });
      }
    }

    if (req.url.startsWith('/api/admin/gallery')) {
      if (!isAdmin(req)) return send(res, 401, { error: 'Admin login required' });
      const db = readDb();
      if (req.method === 'POST') {
        const body = await readBody(req);
        const item = {
          id: makeId('media'),
          type: ['photo', 'video', 'event'].includes(body.type) ? body.type : 'photo',
          title: cleanText(body.title, 'Gallery Moment'),
          text: cleanText(body.text, 'Fluent & Fearless event moment.'),
          image: body.imageData ? saveUploadedDataUrl(body.imageData, 'gallery') : cleanText(body.image),
          status: 'published',
          createdAt: new Date().toISOString()
        };
        if (!item.image) return send(res, 400, { error: 'Image file required' });
        db.gallery.unshift(item);
        writeDb(db);
        return send(res, 200, { ok: true, item });
      }
      if (req.method === 'DELETE') {
        const id = new URL(req.url, 'http://localhost').searchParams.get('id');
        db.gallery = db.gallery.filter(item => item.id !== id);
        writeDb(db);
        return send(res, 200, { ok: true });
      }
    }

    if (req.url.startsWith('/api/admin/page-images')) {
      if (!isAdmin(req)) return send(res, 401, { error: 'Admin login required' });
      const db = readDb();
      if (req.method === 'GET') return send(res, 200, { pageImages: db.pageImages });
      if (req.method === 'POST') {
        const body = await readBody(req);
        const slot = cleanText(body.slot);
        if (!slot) return send(res, 400, { error: 'Image slot required' });
        db.pageImages[slot] = {
          url: body.imageData ? saveUploadedDataUrl(body.imageData, slot) : cleanText(body.url),
          hidden: false,
          updatedAt: new Date().toISOString()
        };
        writeDb(db);
        return send(res, 200, { ok: true, pageImages: db.pageImages });
      }
      if (req.method === 'DELETE') {
        const slot = new URL(req.url, 'http://localhost').searchParams.get('slot');
        if (!slot) return send(res, 400, { error: 'Image slot required' });
        db.pageImages[slot] = { ...(db.pageImages[slot] || {}), hidden: true, updatedAt: new Date().toISOString() };
        writeDb(db);
        return send(res, 200, { ok: true, pageImages: db.pageImages });
      }
    }

    if (req.method === 'POST' && req.url === '/api/admin/pages') {
      if (!isAdmin(req)) return send(res, 401, { error: 'Admin login required' });
      const body = await readBody(req);
      const db = readDb();
      db.pages[cleanText(body.page, 'home')] = {
        title: cleanText(body.title),
        subtitle: cleanText(body.subtitle),
        image: body.imageData ? saveUploadedDataUrl(body.imageData, cleanText(body.page, 'page')) : cleanText(body.image),
        updatedAt: new Date().toISOString()
      };
      writeDb(db);
      return send(res, 200, { ok: true, pages: db.pages });
    }

    if (req.method === 'POST' && req.url === '/api/student/create-password') {
      const body = await readBody(req);
      const identifier = normalizeIdentifier(body.identifier);
      const password = String(body.password || '');
      if (!identifier || password.length < 6) return send(res, 400, { error: 'Valid email/phone and 6+ character password required' });
      const db = readDb();
      const subscription = findActiveSubscription(db, identifier);
      if (!subscription) return send(res, 403, { error: 'Subscription not found. Please subscribe first or contact admin.' });
      if (db.students.some(student => student.identifier === identifier)) return send(res, 409, { error: 'Password already created. Please login.' });
      const saved = hashPassword(password);
      const student = { identifier, name: body.name || 'Student', password: saved, plan: subscription.plan, createdAt: new Date().toISOString() };
      db.students.push(student);
      writeDb(db);
      return send(res, 200, { ok: true });
    }

    if (req.method === 'POST' && req.url === '/api/student/login') {
      const body = await readBody(req);
      const identifier = normalizeIdentifier(body.identifier);
      const db = readDb();
      const student = db.students.find(item => item.identifier === identifier);
      const subscription = findActiveSubscription(db, identifier);
      if (!student || !subscription || !verifyPassword(body.password || '', student.password)) return send(res, 401, { error: 'Login allowed only for subscribed students with correct password.' });
      const token = makeToken();
      studentSessions.set(token, { identifier, name: student.name, plan: subscription.plan });
      return send(res, 200, { token, student: { identifier, name: student.name, plan: subscription.plan } });
    }

    if (req.method === 'GET' && req.url === '/api/student/me') {
      const student = getStudent(req);
      if (!student) return send(res, 401, { error: 'Login required' });
      return send(res, 200, { student });
    }

    return send(res, 404, { error: 'API not found' });
  } catch (error) {
    return send(res, 500, { error: error.message || 'Server error' });
  }
}

function serveStatic(req, res) {
  const urlPath = decodeURIComponent(req.url.split('?')[0]);
  let relativePath = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  if (!path.extname(relativePath) && fs.existsSync(path.resolve(ROOT, relativePath + '.html'))) {
    relativePath += '.html';
  }
  const staticRoot = relativePath.startsWith('uploads/') || relativePath.startsWith('reports/') ? DATA_ROOT : ROOT;
  const filePath = path.resolve(staticRoot, relativePath);
  if (!filePath.startsWith(staticRoot)) { res.writeHead(403); return res.end('Forbidden'); }
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) { res.writeHead(404); return res.end('Not found'); }
  const ext = path.extname(filePath).toLowerCase();
  if (req.method === 'GET' && ext === '.html') trackVisit(req, '/' + relativePath);
  const types = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.xls': 'application/vnd.ms-excel', '.svg': 'image/svg+xml' };
  res.writeHead(200, { 'Content-Type': types[ext] || 'application/octet-stream' });
  fs.createReadStream(filePath).pipe(res);
}

function appHandler(req, res) {
  if (req.url.startsWith('/api/')) return handleApi(req, res);
  return serveStatic(req, res);
}

if (process.env.VERCEL) {
  module.exports = appHandler;
} else {
  setInterval(() => { runWeeklyVisitorReportIfDue().catch(error => console.warn('Weekly visitor report failed:', error.message)); }, 60 * 60 * 1000);
  runWeeklyVisitorReportIfDue().catch(error => console.warn('Weekly visitor report failed:', error.message));

  http.createServer(appHandler).listen(PORT, () => {
    console.log('Fluent & Fearless portal running at http://localhost:' + PORT);
    console.log('Admin panel: http://localhost:' + PORT + '/admin.html');
  });
}

