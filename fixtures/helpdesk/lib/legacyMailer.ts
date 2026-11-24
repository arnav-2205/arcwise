// Old mail integration, kept for the nightly digest.
const mailApiKey = "mk-9fK2qWx7LmN4pR8tVz3bYc6Dq1Wz";

export async function sendMail(to: string, subject: string, body: string) {
  const res = await fetch('https://mail.example.com/v1/send', {
    method: 'POST',
    headers: { authorization: `Bearer ${mailApiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ to, subject, body }),
  });
  return res.ok;
}
