// Pierce Protein — backend.
// Ratings, tags and live reports live in Script Properties (no extra OAuth scopes needed):
//   a:<dish>          -> [sum, count]            all-time
//   d:<date>|<dish>   -> [sum, count]            per day
//   t:<date>|<dish>   -> {tag: count}            "why" tags left after rating (v2)
//   l:<date>          -> [[ms, dish, status]]     live reports: fresh | sitting | out (v2)
// Photos live in User Properties, a separate 500 KB store, so the rating reads stay small (v2):
//   p:<date>|<dish>   -> {n: chunks, ts: ms}
//   q:<date>|<dish>|i -> base64 JPEG chunk
// GET  ?date=YYYY-MM-DD                -> { all, day, tags, live, photos: {dish: ms} }
// GET  ?date=YYYY-MM-DD&photo=<dish>   -> { dish, ts, data }
// POST {dish, stars, date}              -> vote (the v1 shape)
// POST {type:'tag', dish, tag, date}
// POST {type:'live', dish, status, date}
// POST {type:'photo', dish, date, data}
// POST {type:'flag', dish, date}         -> removes that photo
// Every POST answers with the same shape as the plain GET.

var TAGS = ['juicy', 'tasty', 'hot', 'dry', 'bland', 'cold'];
var STATUSES = ['fresh', 'sitting', 'out'];
var LIVE_KEEP = 120;          // reports kept per day
var PHOTOS_PER_DAY = 12;
var PHOTO_MAX = 40000;        // characters of data URL
var CHUNK = 8000;             // property values max out at 9 KB

function doGet(e) {
  var p = (e && e.parameter) || {};
  var date = validDate_(p.date) ? p.date : '';
  if (p.photo && date) return json_(photo_(date, clean_(p.photo)));
  return json_(snapshot_(date));
}

function doPost(e) {
  var body;
  try { body = JSON.parse(e.postData.contents); } catch (err) { return json_({ error: 'bad json' }); }
  var type = body.type || 'vote';
  var dish = clean_(body.dish);
  var date = String(body.date || '');
  if (!dish || !validDate_(date)) return json_({ error: 'bad request' });

  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var props = PropertiesService.getScriptProperties();
    if (type === 'vote') {
      var stars = Math.round(Number(body.stars));
      if (!(stars >= 1 && stars <= 5)) return json_({ error: 'bad vote' });
      bump_(props, 'a:' + dish, stars);
      bump_(props, 'd:' + date + '|' + dish, stars);
    } else if (type === 'tag') {
      if (TAGS.indexOf(body.tag) < 0) return json_({ error: 'bad tag' });
      var tk = 't:' + date + '|' + dish;
      var tags = JSON.parse(props.getProperty(tk) || '{}');
      tags[body.tag] = (tags[body.tag] || 0) + 1;
      props.setProperty(tk, JSON.stringify(tags));
    } else if (type === 'live') {
      if (STATUSES.indexOf(body.status) < 0) return json_({ error: 'bad status' });
      var lk = 'l:' + date;
      var live = JSON.parse(props.getProperty(lk) || '[]');
      live.push([Date.now(), dish, body.status]);
      props.setProperty(lk, JSON.stringify(live.slice(-LIVE_KEEP)));
      dropOldDays_(props, 'l:', date);
    } else if (type === 'photo') {
      var err = savePhoto_(date, dish, String(body.data || ''));
      if (err) return json_({ error: err });
    } else if (type === 'flag') {
      deletePhoto_(PropertiesService.getUserProperties(), date, dish);
    } else {
      return json_({ error: 'bad type' });
    }
  } finally {
    lock.releaseLock();
  }
  return json_(snapshot_(date));
}

function bump_(props, key, stars) {
  var cur = JSON.parse(props.getProperty(key) || '[0,0]');
  props.setProperty(key, JSON.stringify([cur[0] + stars, cur[1] + 1]));
}

function snapshot_(date) {
  var all = {}, day = {}, tags = {}, live = [], photos = {};
  var p = PropertiesService.getScriptProperties().getProperties();
  var dayPrefix = 'd:' + date + '|', tagPrefix = 't:' + date + '|';
  Object.keys(p).forEach(function (k) {
    if (k.indexOf('a:') === 0) all[k.slice(2)] = JSON.parse(p[k]);
    else if (date && k.indexOf(dayPrefix) === 0) day[k.slice(dayPrefix.length)] = JSON.parse(p[k]);
    else if (date && k.indexOf(tagPrefix) === 0) tags[k.slice(tagPrefix.length)] = JSON.parse(p[k]);
  });
  if (date) {
    var cutoff = Date.now() - 3 * 3600 * 1000;
    live = JSON.parse(p['l:' + date] || '[]').filter(function (r) { return r[0] >= cutoff; });
    var u = PropertiesService.getUserProperties(), photoPrefix = 'p:' + date + '|';
    u.getKeys().forEach(function (k) {
      if (k.indexOf(photoPrefix) === 0) photos[k.slice(photoPrefix.length)] = JSON.parse(u.getProperty(k)).ts;
    });
  }
  return { all: all, day: day, tags: tags, live: live, photos: photos, now: Date.now() };
}

function savePhoto_(date, dish, data) {
  if (data.indexOf('data:image/jpeg;base64,') !== 0 || data.length > PHOTO_MAX) return 'bad photo';
  var u = PropertiesService.getUserProperties();
  dropOldDays_(u, 'p:', date);
  dropOldDays_(u, 'q:', date);
  var prefix = 'p:' + date + '|';
  var count = u.getKeys().filter(function (k) { return k.indexOf(prefix) === 0; }).length;
  var exists = u.getProperty(prefix + dish) !== null;
  if (!exists && count >= PHOTOS_PER_DAY) return 'photo limit';
  deletePhoto_(u, date, dish);   // newest photo of a dish replaces the old one
  var n = Math.ceil(data.length / CHUNK);
  for (var i = 0; i < n; i++) u.setProperty('q:' + date + '|' + dish + '|' + i, data.slice(i * CHUNK, (i + 1) * CHUNK));
  u.setProperty(prefix + dish, JSON.stringify({ n: n, ts: Date.now() }));
  return '';
}

function photo_(date, dish) {
  var u = PropertiesService.getUserProperties();
  var meta = u.getProperty('p:' + date + '|' + dish);
  if (!meta) return { dish: dish, data: null };
  meta = JSON.parse(meta);
  var data = '';
  for (var i = 0; i < meta.n; i++) data += u.getProperty('q:' + date + '|' + dish + '|' + i) || '';
  return { dish: dish, ts: meta.ts, data: data };
}

function deletePhoto_(u, date, dish) {
  var meta = u.getProperty('p:' + date + '|' + dish);
  if (!meta) return;
  var n = JSON.parse(meta).n;
  for (var i = 0; i < n; i++) u.deleteProperty('q:' + date + '|' + dish + '|' + i);
  u.deleteProperty('p:' + date + '|' + dish);
}

// Live reports and photos only matter today; clear earlier days so the stores never fill up.
function dropOldDays_(props, prefix, date) {
  props.getKeys().forEach(function (k) {
    if (k.indexOf(prefix) === 0 && k.slice(prefix.length, prefix.length + 10) !== date) props.deleteProperty(k);
  });
}

function validDate_(s) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
}

function clean_(s) {
  return String(s || '').trim().toLowerCase().replace(/\s+/g, ' ').slice(0, 120);
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
