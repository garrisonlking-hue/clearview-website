// api/lead.js  —  Vercel serverless function
// Receives quote-builder submissions and creates a LEAD in Flyra by
// submitting to the org's public lead form. Nothing is booked or
// scheduled — the requested time lives in the lead notes, and we
// call/text to confirm before putting anything on the schedule.
// The form submission also triggers Flyra's new-lead automations
// (auto-text to the customer + a follow-up task for us).

const FORM_ID = 'rappydf6';

const SERVICE_VALUES = {
  'exterior windows': 'exterior_windows',
  'interior windows': 'interior_windows',
  'sill & track detailing': 'sill_track_detailing',
  'screen cleaning': 'screen_cleaning',
  'solar panel cleaning': 'solar_panel_cleaning',
  'solar panels': 'solar_panel_cleaning',
  'pressure washing': 'pressure_washing',
};

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  let b = req.body;
  if (typeof b === 'string') { try { b = JSON.parse(b); } catch { b = {}; } }
  b = b || {};

  if (!b.phone && !b.email) {
    return res.status(400).json({ error: 'Phone or email required' });
  }

  // Normalize US phone to a clean form
  let phone = String(b.phone || '').replace(/[^\d+]/g, '');
  if (phone && !phone.startsWith('+')) {
    const digits = phone.replace(/\D/g, '');
    if (digits.length === 10) phone = '+1' + digits;
    else if (digits.length === 11 && digits.startsWith('1')) phone = '+' + digits;
  }

  // Map the builder's service list onto the lead form's select values
  const rawService = String(b.service || '').toLowerCase().trim();
  let service_type = 'other';
  if (rawService.includes(',')) service_type = 'multiple_services';
  else if (SERVICE_VALUES[rawService]) service_type = SERVICE_VALUES[rawService];

  const payload = {
    first_name: String(b.name || '').trim() || 'Website Lead',
    phone: phone || undefined,
    email: b.email || undefined,
    address: b.address || undefined,
    service_type,
    preferred_date: b.scheduled_start ? String(b.scheduled_start).slice(0, 10) : undefined,
    notes: b.notes || undefined,
    sms_consent: !!b.sms_consent,
  };

  try {
    const r = await fetch(`https://app.flyra.io/api/forms/public/${FORM_ID}/submit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ payload }),
    });

    const text = await r.text();
    if (!r.ok) {
      console.error('Flyra form error', r.status, text);
      return res.status(502).json({ error: 'Flyra rejected the lead', detail: text });
    }
    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error('Lead create failed', e);
    return res.status(500).json({ error: 'Could not reach Flyra' });
  }
}
