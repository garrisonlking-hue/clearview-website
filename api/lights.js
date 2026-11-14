// api/lights.js  —  Vercel serverless function for the holiday lights quote tool
// (lights-quote.html). Keeps the Google Maps and OpenAI keys on the server.
//
// Environment variables (set in Vercel > Project > Settings > Environment Variables):
//   GOOGLE_MAPS_API_KEY   Geocoding API + Street View Static API + Maps Static API
//   OPENAI_API_KEY        used for the mockup image
//   LIGHTS_PASSCODE       any phrase you choose; the page asks for it once
// Optional:
//   OPENAI_IMAGE_MODEL    default "gpt-image-1"
//   OPENAI_IMAGE_QUALITY  default "medium" (low | medium | high)

export const config = { maxDuration: 300 };

const G = 'https://maps.googleapis.com/maps/api';
const FLYRA = 'https://app.flyra.io/v2026-06-01';

// Flyra customers, cached in the function for 10 minutes (used for address suggestions and name autofill)
let CUST = { at: 0, list: [] };
async function flyraCustomers(key) {
  if (!key) return [];
  if (Date.now() - CUST.at < 600000 && CUST.list.length) return CUST.list;
  const out = [];
  for (let off = 0; off < 3000; off += 100) {
    const r = await fetch(`${FLYRA}/customers?limit=100&offset=${off}`, { headers: { Authorization: 'Bearer ' + key } });
    if (!r.ok) break;
    const j = await r.json().catch(() => ({}));
    const rows = j.data || [];
    rows.forEach((c) => out.push({ id: c.id,
      name: c.display_name || [c.first_name, c.last_name].filter(Boolean).join(' '),
      first: c.first_name || '', phone: c.mobile_phone || '',
      address: String(c.address || '').split('\n')[0].trim(),
      city: c.city || '', state: c.state || '', zip: c.zip || c.zipcode || '',
      full: String(c.address || '').replace(/\n/g, ', ') }));
    if (rows.length < 100) break;
  }
  CUST = { at: Date.now(), list: out };
  return out;
}
const norm = (x) => String(x || '').toLowerCase().replace(/[.,#]/g, ' ').replace(/\b(road)\b/g, 'rd').replace(/\b(lane)\b/g, 'ln')
  .replace(/\b(street)\b/g, 'st').replace(/\b(drive)\b/g, 'dr').replace(/\b(avenue)\b/g, 'ave').replace(/\b(court)\b/g, 'ct')
  .replace(/\b(circle)\b/g, 'cir').replace(/\b(route)\b/g, 'rt').replace(/\s+/g, ' ').trim();
function sameStreet(a, b) {
  const x = norm(a).split(' '), y = norm(b).split(' ');
  return x.length > 1 && y.length > 1 && x[0] === y[0] && /^\d/.test(x[0]) && x[1] === y[1];
}

// Building outline from OpenStreetMap (fallback when Google has no roof data). Picks the outline that contains
// the address point (or the nearest one within 18 m), skips sheds, and finds the direction of the nearest road.
function pickBuilding(j, lat, lng) {
  const N = new Map(); j.elements.forEach((e) => { if (e.type === 'node') N.set(e.id, e); });
  const mx = 111320 * Math.cos(lat * Math.PI / 180), my = 110540;
  const P = (n) => [(n.lon - lng) * mx, (n.lat - lat) * my];
  const segd = (p, a, b) => { const dx = b[0] - a[0], dy = b[1] - a[1], L = dx * dx + dy * dy || 1e-9;
    const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L)); const q = [a[0] + t * dx, a[1] + t * dy];
    return [Math.hypot(p[0] - q[0], p[1] - q[1]), q]; };
  const inside = (p, s) => { let c = false; for (let i = 0; i < s.length - 1; i++) { const a = s[i], b = s[i + 1];
    if ((a[1] > p[1]) !== (b[1] > p[1]) && p[0] < (b[0] - a[0]) * (p[1] - a[1]) / (b[1] - a[1]) + a[0]) c = !c; } return c; };
  const area = (s) => { let t = 0; for (let i = 0; i < s.length - 1; i++) t += s[i][0] * s[i + 1][1] - s[i + 1][0] * s[i][1]; return Math.abs(t) / 2; };
  const roadT = /^(residential|primary|secondary|tertiary|unclassified|living_street|trunk|service)$/;
  let best = null; const roads = [];
  j.elements.forEach((w) => {
    if (w.type !== 'way' || !w.nodes.every((id) => N.has(id))) return;
    const t = w.tags || {}, s = w.nodes.map((id) => P(N.get(id)));
    if (t.building && s.length > 3) {
      const A = area(s); if (A < 55) return; // sheds
      const d = inside([0, 0], s) ? 0 : Math.min(...s.slice(1).map((q, i) => segd([0, 0], s[i], q)[0]));
      if (!best || d < best.d || (d === best.d && A > best.A)) best = { d, s, A, tags: t };
    } else if (t.highway && roadT.test(t.highway) && t.service !== 'driveway') roads.push(s);
  });
  if (!best || best.d > 18) return null;
  const s = best.s, cx = s.slice(1).reduce((a, p) => a + p[0], 0) / (s.length - 1), cy = s.slice(1).reduce((a, p) => a + p[1], 0) / (s.length - 1);
  let road = null;
  roads.forEach((r) => r.slice(1).forEach((q, i) => { const [d, pt] = segd([cx, cy], r[i], q); if (!road || d < road.d) road = { d, pt }; }));
  return { poly: s.map((p) => [+(p[0]).toFixed(2), +(p[1]).toFixed(2)]), dist: +best.d.toFixed(1), area: Math.round(best.A),
    road: road ? { dir: Math.round((Math.atan2(road.pt[0] - cx, road.pt[1] - cy) * 180 / Math.PI + 360) % 360), dist: Math.round(road.d) } : null,
    levels: best.tags['building:levels'] || null, kind: best.tags.building };
}
async function osmMap(lat, lng) {
  const UA = { 'User-Agent': 'lights-quote-tool/1.0' };
  const dy = 0.00045, dx = dy / Math.cos(lat * Math.PI / 180);
  try { // main OpenStreetMap API: everything in a ~100 m box
    const r = await fetch(`https://api.openstreetmap.org/api/0.6/map.json?bbox=${lng - dx},${lat - dy},${lng + dx},${lat + dy}`, { headers: UA, signal: AbortSignal.timeout(8000) });
    if (r.ok) return { j: await r.json(), src: 'OpenStreetMap' };
  } catch (e) { /* try Overpass */ }
  const q = `[out:json][timeout:8];(way["building"](around:60,${lat},${lng});way["highway"](around:90,${lat},${lng}););out body;>;out skel qt;`;
  const r = await fetch('https://overpass-api.de/api/interpreter', { method: 'POST', headers: { ...UA, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'data=' + encodeURIComponent(q), signal: AbortSignal.timeout(9000) });
  if (!r.ok) throw new Error('map outline service busy (' + r.status + ')');
  return { j: await r.json(), src: 'OpenStreetMap (Overpass)' };
}

function bearing(lat1, lng1, lat2, lng2) {
  const r = Math.PI / 180;
  const y = Math.sin((lng2 - lng1) * r) * Math.cos(lat2 * r);
  const x = Math.cos(lat1 * r) * Math.sin(lat2 * r) -
            Math.sin(lat1 * r) * Math.cos(lat2 * r) * Math.cos((lng2 - lng1) * r);
  return (Math.atan2(y, x) / r + 360) % 360;
}

async function googleImage(res, url) {
  const r = await fetch(url);
  if (!r.ok) {
    const t = await r.text();
    return res.status(502).json({ error: 'Google image request failed: ' + t.slice(0, 300) });
  }
  const buf = Buffer.from(await r.arrayBuffer());
  res.setHeader('Content-Type', r.headers.get('content-type') || 'image/jpeg');
  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).send(buf);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  let b = req.body;
  if (typeof b === 'string') { try { b = JSON.parse(b); } catch { b = {}; } }
  b = b || {};

  const PASS = process.env.LIGHTS_PASSCODE;
  const FKEY = process.env.FLYRA_API_KEY;
  const GKEY = process.env.GOOGLE_MAPS_API_KEY;
  const OKEY = process.env.OPENAI_API_KEY;
  const MODEL = process.env.OPENAI_IMAGE_MODEL || 'gpt-image-1';
  const QUALITY = process.env.OPENAI_IMAGE_QUALITY || 'medium';

  if (!PASS) return res.status(503).json({ error: 'LIGHTS_PASSCODE is not set in Vercel yet.' });
  if ((req.headers['x-lights-pass'] || '') !== PASS) return res.status(401).json({ error: 'Wrong passcode.' });

  try {
    // ---- setup check: which keys exist and whether each service answers
    if (b.action === 'check') {
      const out = { passcode: true, googleKey: !!GKEY, openaiKey: !!OKEY, model: MODEL };
      if (FKEY) { const fr = await fetch(`${FLYRA}/customers?limit=1`, { headers: { Authorization: 'Bearer ' + FKEY } }); out.flyra = fr.ok ? 'ok' : `failed (${fr.status})`; }
      else out.flyra = 'FLYRA_API_KEY missing in Vercel';
      if (GKEY) {
        const j = await (await fetch(`${G}/geocode/json?address=${encodeURIComponent('Columbia, CT')}&key=${GKEY}`)).json();
        out.geocoding = j.status === 'OK' ? 'ok' : `${j.status}: ${j.error_message || ''}`;
        const m = await (await fetch(`${G}/streetview/metadata?location=41.7,-72.3&key=${GKEY}`)).json();
        out.streetView = (m.status === 'OK' || m.status === 'ZERO_RESULTS') ? 'ok' : `${m.status}: ${m.error_message || ''}`;
        const s = await fetch(`${G}/staticmap?center=41.7,-72.3&zoom=18&size=64x64&maptype=satellite&key=${GKEY}`);
        out.staticMap = s.ok ? 'ok' : 'failed: ' + (await s.text()).slice(0, 200);
        const t = await fetch(`https://tile.googleapis.com/v1/3dtiles/root.json?key=${GKEY}`);
        out.tiles3d = t.ok ? 'ok' : `failed (${t.status}): ` + (await t.text()).slice(0, 200);
        const so = await fetch(`https://solar.googleapis.com/v1/buildingInsights:findClosest?location.latitude=41.7161&location.longitude=-72.3197&requiredQuality=LOW&key=${GKEY}`);
        out.solar = (so.ok || so.status === 404) ? 'ok' : `failed (${so.status}): ` + (await so.text()).slice(0, 200);
        const pl = await fetch('https://places.googleapis.com/v1/places:autocomplete', { method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': GKEY }, body: JSON.stringify({ input: '57 Jasmine Ln' }) });
        out.places = pl.ok ? 'ok' : `failed (${pl.status}): ` + (await pl.text()).slice(0, 160);
      }
      if (OKEY) {
        const r = await fetch('https://api.openai.com/v1/models/' + encodeURIComponent(MODEL),
          { headers: { Authorization: 'Bearer ' + OKEY } });
        out.openai = r.ok ? 'ok' : `failed (${r.status}): ` + (await r.text()).slice(0, 200);
      }
      return res.status(200).json(out);
    }

    // ---- address suggestions while typing: Flyra customers first, then Google addresses
    if (b.action === 'suggest') {
      const q = String(b.q || '').trim();
      if (q.length < 3) return res.status(200).json({ items: [] });
      const items = [];
      try {
        const nq = norm(q);
        (await flyraCustomers(FKEY)).forEach((c) => {
          if (items.length >= 4) return;
          const hay = norm(c.name + ' ' + c.full + ' ' + c.city);
          if (nq.split(' ').every((w) => hay.includes(w)) && c.address) {
            items.push({ type: 'customer', name: c.name, first: c.first,
              address: [c.address, c.city, [c.state, c.zip].filter(Boolean).join(' ')].filter(Boolean).join(', ') });
          }
        });
      } catch (e) { /* Flyra unavailable: just Google */ }
      let googleNote = '';
      if (GKEY) {
        const r = await fetch('https://places.googleapis.com/v1/places:autocomplete', { method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': GKEY },
          body: JSON.stringify({ input: q, includedRegionCodes: ['us'], sessionToken: String(b.session || '').slice(0, 64) || undefined,
            includedPrimaryTypes: ['street_address', 'premise', 'subpremise', 'route'],
            locationRestriction: { rectangle: { low: { latitude: 40.85, longitude: -73.9 }, high: { latitude: 42.2, longitude: -71.6 } } } }) });
        const j = await r.json().catch(() => ({}));
        if (r.ok) (j.suggestions || []).slice(0, 5).forEach((x) => {
          const t = x.placePrediction && x.placePrediction.text && x.placePrediction.text.text;
          if (t) items.push({ type: 'address', address: t.replace(/, USA$/, '') });
        });
        else googleNote = (j.error && j.error.message) || 'Google suggestions unavailable';
      }
      return res.status(200).json({ items, googleNote });
    }

    // ---- is this address already a Flyra customer? (autofills the name)
    if (b.action === 'flyraMatch') {
      try {
        const c = (await flyraCustomers(FKEY)).find((x) => x.address && sameStreet(x.address, b.street));
        return res.status(200).json(c ? { name: c.name, first: c.first, phone: c.phone } : {});
      } catch (e) { return res.status(200).json({}); }
    }

    // ---- photos from this customer's past Flyra jobs (window cleaning photos etc.)
    if (b.action === 'flyraPhotos') {
      if (!FKEY) return res.status(503).json({ error: 'FLYRA_API_KEY is not set in Vercel.' });
      const c = (await flyraCustomers(FKEY)).find((x) => x.address && sameStreet(x.address, b.street));
      if (!c) return res.status(200).json({ photos: [], note: 'No Flyra customer at this address.' });
      const H = { Authorization: 'Bearer ' + FKEY, 'Content-Type': 'application/json' };
      const jr = await fetch(`${FLYRA}/jobs?customer_id=${c.id}&limit=20`, { headers: H });
      const jobs = ((await jr.json().catch(() => ({}))).data || []).slice(0, 8);
      const photos = [];
      const grab = (o, when) => { // collect any image URL in the action's answer, whatever the field is called
        if (!o || typeof o !== 'object') return;
        if (Array.isArray(o)) return o.forEach((x) => grab(x, when));
        const u = Object.values(o).find((v) => typeof v === 'string' && /^https:\/\//.test(v) && !/\.(mp4|mov)(\?|$)/i.test(v));
        if (u && (o.id || o.photo_id || o.url || o.download_url)) photos.push({ url: u, when, type: o.photo_type || o.type || '' });
        else Object.values(o).forEach((v) => { if (v && typeof v === 'object') grab(v, when); });
      };
      for (const j of jobs) {
        const r = await fetch(`${FLYRA}/actions/flyra_list_job_photos`, { method: 'POST', headers: H, body: JSON.stringify({ job_id: j.id, limit: 12 }) });
        if (r.ok) grab((await r.json().catch(() => ({}))).data, j.scheduled_start || j.created_at || '');
        if (photos.length >= 24) break;
      }
      return res.status(200).json({ name: c.name, photos: photos.filter((p) => !/video/i.test(p.type)).slice(0, 24) });
    }

    // ---- fetch one image for the page (when the photo host blocks direct browser use)
    if (b.action === 'imageProxy') {
      const u = String(b.url || '');
      if (!/^https:\/\/[a-z0-9-]+\.supabase\.co\//i.test(u) && !/^https:\/\/app\.flyra\.io\//i.test(u)) return res.status(400).json({ error: 'Not a Flyra photo link.' });
      return googleImage(res, u);
    }

    // ---- Google 3D tiles are loaded straight by the browser, so the page needs the key (passcode holders only)
    if (b.action === 'tilesKey') {
      if (!GKEY) return res.status(503).json({ error: 'GOOGLE_MAPS_API_KEY is not set in Vercel yet.' });
      return res.status(200).json({ key: GKEY });
    }

    // ---- roof planes from Google Solar API (pitch, facing, size) for the automatic footage estimate
    if (b.action === 'roof') {
      if (!GKEY) return res.status(503).json({ error: 'GOOGLE_MAPS_API_KEY is not set.' });
      let last = '';
      for (const q of ['HIGH', 'MEDIUM', 'LOW']) {
        const r = await fetch(`https://solar.googleapis.com/v1/buildingInsights:findClosest?location.latitude=${Number(b.lat)}&location.longitude=${Number(b.lng)}&requiredQuality=${q}&exactQualityRequired=true&key=${GKEY}`);
        const j = await r.json().catch(() => ({}));
        if (r.ok && j.solarPotential) {
          const segs = (j.solarPotential.roofSegmentStats || []).map((g) => ({
            pitch: g.pitchDegrees || 0, azimuth: g.azimuthDegrees || 0,
            area: (g.stats && g.stats.areaMeters2) || 0, ground: (g.stats && g.stats.groundAreaMeters2) || 0,
            bbox: g.boundingBox, center: g.center, height: g.planeHeightAtCenterMeters }));
          return res.status(200).json({ quality: j.imageryQuality, center: j.center, bbox: j.boundingBox, segments: segs });
        }
        last = (j.error && j.error.message) || `Solar API error ${r.status}`;
        if (r.status === 403) break;
      }
      return res.status(502).json({ error: 'No roof data: ' + last });
    }

    // ---- building outline from OpenStreetMap: fallback footage when Google has no roof data
    if (b.action === 'footprint') {
      const lat = Number(b.lat), lng = Number(b.lng);
      if (!isFinite(lat) || !isFinite(lng)) return res.status(400).json({ error: 'No location.' });
      const { j, src } = await osmMap(lat, lng);
      const F = pickBuilding(j, lat, lng);
      if (!F) return res.status(404).json({ error: 'No building outline on the map at this address.' });
      return res.status(200).json({ ...F, source: src });
    }

    // ---- address -> coordinates + nearest Street View
    if (b.action === 'lookup') {
      if (!GKEY) return res.status(503).json({ error: 'GOOGLE_MAPS_API_KEY is not set in Vercel yet.' });
      const address = String(b.address || '').trim();
      if (!address) return res.status(400).json({ error: 'No address given.' });
      const g = await (await fetch(`${G}/geocode/json?address=${encodeURIComponent(address)}&components=country:US&key=${GKEY}`)).json();
      if (g.status !== 'OK' || !g.results.length) {
        return res.status(404).json({ error: `Address not found (${g.status}). ${g.error_message || ''}` });
      }
      const top = g.results[0];
      const { lat, lng } = top.geometry.location;
      const part = (t) => (top.address_components.find((c) => c.types.includes(t)) || {});
      const street = [part('street_number').long_name, part('route').long_name].filter(Boolean).join(' ');
      const cityLine = [part('locality').long_name || part('sublocality').long_name || part('administrative_area_level_3').long_name,
        [part('administrative_area_level_1').short_name, part('postal_code').long_name].filter(Boolean).join(' ')].filter(Boolean).join(', ');
      const m = await (await fetch(`${G}/streetview/metadata?location=${lat},${lng}&source=outdoor&radius=60&key=${GKEY}`)).json();
      const out = { lat, lng, formatted: top.formatted_address, street, cityLine,
        precise: top.geometry.location_type === 'ROOFTOP', streetView: null };
      if (m.status === 'OK') {
        out.streetView = { pano: m.pano_id, date: m.date || null,
          heading: Math.round(bearing(m.location.lat, m.location.lng, lat, lng)) };
      }
      return res.status(200).json(out);
    }

    // ---- every Street View spot around the house (metadata lookups are free): rings of points, snapped to the nearest panorama
    if (b.action === 'svSpots') {
      if (!GKEY) return res.status(503).json({ error: 'GOOGLE_MAPS_API_KEY is not set.' });
      const lat = Number(b.lat), lng = Number(b.lng), mx = 111320 * Math.cos(lat * Math.PI / 180), my = 110540;
      const pts = [[lat, lng]];
      [22, 45, 70].forEach((rad) => { for (let a = 0; a < 360; a += 30) pts.push([lat + rad * Math.cos(a * Math.PI / 180) / my, lng + rad * Math.sin(a * Math.PI / 180) / mx]); });
      const found = new Map();
      await Promise.all(pts.map(async ([la, ln]) => {
        try {
          const m = await (await fetch(`${G}/streetview/metadata?location=${la},${ln}&source=outdoor&radius=35&key=${GKEY}`)).json();
          if (m.status !== 'OK' || found.has(m.pano_id)) return;
          const dist = Math.hypot((m.location.lng - lng) * mx, (m.location.lat - lat) * my);
          if (dist > 90 || dist < 4) return;
          found.set(m.pano_id, { pano: m.pano_id, lat: m.location.lat, lng: m.location.lng, date: m.date || null, dist: Math.round(dist),
            heading: Math.round(bearing(m.location.lat, m.location.lng, lat, lng)) });
        } catch (e) { /* skip this point */ }
      }));
      const spots = [...found.values()].sort((x, y) => x.dist - y.dist).slice(0, 24);
      return res.status(200).json({ spots });
    }

    // ---- Street View photo
    if (b.action === 'streetview') {
      if (!GKEY) return res.status(503).json({ error: 'GOOGLE_MAPS_API_KEY is not set.' });
      const q = new URLSearchParams({ size: '640x427', pano: String(b.pano), heading: String(Number(b.heading) || 0),
        pitch: String(Number(b.pitch) || 0), fov: String(Number(b.fov) || 75), key: GKEY });
      return googleImage(res, `${G}/streetview?${q}`);
    }

    // ---- satellite image for measuring
    if (b.action === 'satellite') {
      if (!GKEY) return res.status(503).json({ error: 'GOOGLE_MAPS_API_KEY is not set.' });
      const zoom = Math.min(21, Math.max(17, Number(b.zoom) || 20));
      const q = new URLSearchParams({ center: `${Number(b.lat)},${Number(b.lng)}`, zoom: String(zoom),
        size: '640x640', scale: '2', maptype: 'satellite', key: GKEY });
      return googleImage(res, `${G}/staticmap?${q}`);
    }

    // ---- pick the photo that shows the front of the house best (small, cheap vision call)
    if (b.action === 'pick') {
      if (!OKEY) return res.status(503).json({ error: 'OPENAI_API_KEY is not set in Vercel yet.' });
      const imgs = (Array.isArray(b.images) ? b.images : []).filter((u) => /^data:image\/(jpeg|png|webp);base64,/.test(u)).slice(0, 8);
      if (!imgs.length) return res.status(400).json({ error: 'No photos to compare.' });
      const content = [{ type: 'text', text:
        `These ${imgs.length} images (numbered 0 to ${imgs.length - 1}) are candidate views of the house at ${String(b.address || 'the address')} ` +
        'for a Christmas-lights mockup. ' + String(b.hint || '').slice(0, 600) + ' Views of a 3D map model look a little blurry, which is fine. ' +
        'Score each 0-10. The best reference shows the FRONT of the house (the side with the front door, usually facing the street and driveway), ' +
        'with the whole front roofline visible, the house filling much of the frame and not cut off, and not hidden by trees. ' +
        '3D map views are always taken from above; that is normal and must not lower the score. A clear 3D view of the front should score 7 to 9. Between equally clear views, prefer the lower, more eye-level one. ' +
        'A side or rear view scores at most 4 even if it is clear. A view where trees cover most of the front scores at most 4. ' +
        'Blank, garbled, flat terrain with no recognizable 3D house, or the wrong building scores 0. ' +
        'Reply as JSON: {"scores":[...],"best":index,"usable":true|false,"reason":"one short sentence"}. usable is false if no image scores 5 or more.' }];
      imgs.forEach((u) => content.push({ type: 'image_url', image_url: { url: u, detail: 'low' } }));
      let last = '';
      for (const model of [process.env.OPENAI_VISION_MODEL, 'gpt-4.1-mini', 'gpt-4o-mini'].filter(Boolean)) {
        const r = await fetch('https://api.openai.com/v1/chat/completions', { method: 'POST',
          headers: { Authorization: 'Bearer ' + OKEY, 'Content-Type': 'application/json' },
          body: JSON.stringify({ model, response_format: { type: 'json_object' }, max_tokens: 300, messages: [{ role: 'user', content }] }) });
        const j = await r.json().catch(() => ({}));
        if (r.ok && j.choices && j.choices[0]) {
          try { const out = JSON.parse(j.choices[0].message.content); out.model = model; return res.status(200).json(out); }
          catch (e) { last = 'Could not read the answer.'; continue; }
        }
        last = (j.error && j.error.message) || `OpenAI error ${r.status}`;
      }
      return res.status(502).json({ error: 'Photo pick failed: ' + last });
    }

    // ---- mockup: house photo + prompt -> edited image
    if (b.action === 'mockup') {
      if (!OKEY) return res.status(503).json({ error: 'OPENAI_API_KEY is not set in Vercel yet.' });
      const prompt = String(b.prompt || '').trim();
      const m = /^data:(image\/(?:jpeg|png|webp));base64,(.+)$/.exec(String(b.image || ''));
      if (!prompt || !m) return res.status(400).json({ error: 'Need a prompt and a house photo.' });
      const buf = Buffer.from(m[2], 'base64');
      const ext = m[1].split('/')[1].replace('jpeg', 'jpg');
      // Image model names change over time; try the configured one, then known fallbacks.
      const models = [...new Set([MODEL, 'gpt-image-2', 'gpt-image-1.5', 'gpt-image-1', 'gpt-image-1-mini'])];
      let mi = 0;
      const params = { model: models[0], prompt, size: b.portrait ? '1024x1536' : '1536x1024', quality: QUALITY,
        input_fidelity: b.fidelity === 'low' ? 'low' : 'high', output_format: 'jpeg', output_compression: '85' };

      let last = ''; const tried = [];
      for (let attempt = 0; attempt < 12; attempt++) {
        const fd = new FormData();
        for (const [k, v] of Object.entries(params)) fd.append(k, v);
        fd.append('image', new Blob([buf], { type: m[1] }), 'house.' + ext);
        const r = await fetch('https://api.openai.com/v1/images/edits',
          { method: 'POST', headers: { Authorization: 'Bearer ' + OKEY }, body: fd });
        const j = await r.json().catch(() => ({}));
        if (r.ok && j.data && j.data[0] && j.data[0].b64_json) {
          const fmt = params.output_format === 'jpeg' ? 'jpeg' : 'png';
          if (j.data[0].b64_json.length > 4200000) {
            return res.status(502).json({ error: 'The image came back too large to return. Set OPENAI_IMAGE_QUALITY to "low" or "medium" in Vercel.' });
          }
          return res.status(200).json({ image: `data:image/${fmt};base64,${j.data[0].b64_json}`, model: params.model });
        }
        last = (j.error && j.error.message) || `OpenAI error ${r.status}`;
        const code = (j.error && j.error.code) || '';
        if ((code === 'model_not_found' || /does not exist|not supported|do not have access|must be verified/i.test(last)) && mi < models.length - 1) {
          tried.push(`${params.model}: ${last}`); params.model = models[++mi];
          Object.assign(params, { input_fidelity: b.fidelity === 'low' ? 'low' : 'high', output_format: 'jpeg', output_compression: '85', quality: QUALITY });
          continue;
        }
        // Model versions differ in which optional settings they accept: drop the one named and retry.
        const bad = (j.error && j.error.param) || (/Unknown parameter: '([a-z_]+)'/.exec(last) || [])[1];
        if (r.status === 400 && bad && bad in params && !['model', 'prompt', 'size'].includes(bad)) { delete params[bad]; continue; }
        break;
      }
      return res.status(502).json({ error: 'Mockup failed: ' + last + (tried.length ? '\nAlso tried: ' + tried.join(' | ') : '') });
    }

    return res.status(400).json({ error: 'Unknown action.' });
  } catch (e) {
    return res.status(500).json({ error: 'Server error: ' + (e && e.message ? e.message : String(e)) });
  }
}
