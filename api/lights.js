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
      }
      if (OKEY) {
        const r = await fetch('https://api.openai.com/v1/models/' + encodeURIComponent(MODEL),
          { headers: { Authorization: 'Bearer ' + OKEY } });
        out.openai = r.ok ? 'ok' : `failed (${r.status}): ` + (await r.text()).slice(0, 200);
      }
      return res.status(200).json(out);
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
        `These ${imgs.length} images (numbered 0 to ${imgs.length - 1}) all try to show the same house at ${String(b.address || 'the address')}. ` +
        'Image 0 may be a street-level photo; the rest are views of a 3D map model (those look a bit blurry, which is fine). ' +
        'Score each 0-10 for how well it works as the reference for a front-of-house Christmas lights mockup: the front of the house and its roofline clearly visible, ' +
        'house large in frame, not hidden by trees, not the back of the house, not a different building. Score 0 for blank, garbage or the wrong subject. ' +
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
