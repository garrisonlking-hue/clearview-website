
// api/lead.js  —  Vercel serverless function
// Receives quote-builder submissions and creates a JOB in Flyra
// (customer + scheduled job + price) via the public REST API.
//
// The Flyra key NEVER touches the browser — it lives only in Vercel
// env vars. Set it in: Vercel → Project → Settings → Environment
// Variables → FLYRA_API_KEY = flr_live_...

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const KEY = process.env.FLYRA_API_KEY;
  if (!KEY) return res.status(500).json({ error: 'Server not configured' });

  let b = req.body;
  if (typeof b === 'string') { try { b = JSON.parse(b); } catch { b = {}; } }
  b = b || {};

  if (!b.phone && !b.email) {
    return res.status(400).json({ error: 'Phone or email required' });
  }

  // Split "Jane Doe" -> first / last (Flyra needs at least one)
  const parts = String(b.name || '').trim().split(/\s+/);
  const first_name = parts.shift() || '';
  const last_name = parts.join(' ') || '';

  // Normalize US phone to a clean form
  let phone = String(b.phone || '').replace(/[^\d+]/g, '');
  if (phone && !phone.startsWith('+')) {
    const digits = phone.replace(/\D/g, '');
    if (digits.length === 10) phone = '+1' + digits;
    else if (digits.length === 11 && digits.startsWith('1')) phone = '+' + digits;
  }

  // Build the job payload per Flyra's POST /api/public/jobs spec.
  const payload = {
    customer: {
      first_name: first_name || (last_name ? '' : 'Website'),
      last_name,
      email: b.email || undefined,
      mobile_phone: phone || undefined,
      address: b.address || undefined,
    },
    service: b.service || 'Window Cleaning',
    notes: b.notes || undefined,
  };
  if (b.scheduled_start) payload.scheduled_start = b.scheduled_start;
  if (b.scheduled_end) payload.scheduled_end = b.scheduled_end;
  if (b.price != null && !isNaN(b.price)) payload.price = Number(b.price);

  try {
    const r = await fetch('https://app.flyra.io/api/public/jobs', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    const text = await r.text();
    if (!r.ok) {
      console.error('Flyra error', r.status, text);
      return res.status(502).json({ error: 'Flyra rejected the job', detail: text });
    }
    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error('Job create failed', e);
    return res.status(500).json({ error: 'Could not reach Flyra' });
  }
}
