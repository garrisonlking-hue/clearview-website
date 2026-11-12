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
      }
      if (OKEY) {
        const r = await fetch('https://api.openai.com/v1/models/' + encodeURIComponent(MODEL),
          { headers: { Authorization: 'Bearer ' + OKEY } });
        out.openai = r.ok ? 'ok' : `failed (${r.status}): ` + (await r.text()).slice(0, 200);
      }
      return res.status(200).json(out);
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

    // ---- mockup: house photo + prompt -> edited image
    if (b.action === 'mockup') {
      if (!OKEY) return res.status(503).json({ error: 'OPENAI_API_KEY is not set in Vercel yet.' });
      const prompt = String(b.prompt || '').trim();
      const m = /^data:(image\/(?:jpeg|png|webp));base64,(.+)$/.exec(String(b.image || ''));
      if (!prompt || !m) return res.status(400).json({ error: 'Need a prompt and a house photo.' });
      const buf = Buffer.from(m[2], 'base64');
      const ext = m[1].split('/')[1].replace('jpeg', 'jpg');
      const params = { model: MODEL, prompt, size: b.portrait ? '1024x1536' : '1536x1024', quality: QUALITY,
        input_fidelity: 'high', output_format: 'jpeg', output_compression: '85' };

      let last = '';
      for (let attempt = 0; attempt < 4; attempt++) {
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
          return res.status(200).json({ image: `data:image/${fmt};base64,${j.data[0].b64_json}`, model: MODEL });
        }
        last = (j.error && j.error.message) || `OpenAI error ${r.status}`;
        // Model versions differ in which optional settings they accept: drop the one named and retry.
        const bad = (j.error && j.error.param) || (/Unknown parameter: '([a-z_]+)'/.exec(last) || [])[1];
        if (r.status === 400 && bad && bad in params && !['model', 'prompt', 'size'].includes(bad)) { delete params[bad]; continue; }
        break;
      }
      return res.status(502).json({ error: 'Mockup failed: ' + last });
    }

    return res.status(400).json({ error: 'Unknown action.' });
  } catch (e) {
    return res.status(500).json({ error: 'Server error: ' + (e && e.message ? e.message : String(e)) });
  }
}
