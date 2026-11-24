import { sendMail } from './legacyMailer';

export async function notify(team: string, message: string) {
  await sendMail(`${team}@acme.example`, 'Helpdesk', message);
}
