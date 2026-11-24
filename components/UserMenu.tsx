'use client';
import { LogOut } from 'lucide-react';
import type { Me } from '../lib/client';

export function Avatar({ user }: { user: NonNullable<Me['user']> }) {
  // eslint-disable-next-line @next/next/no-img-element
  return user.avatarUrl ? <img className="avatar" src={user.avatarUrl} alt="" /> : <span className="avatar" aria-hidden />;
}

export default function UserMenu({ me }: { me: Me }) {
  if (!me.user) return null;
  return (
    <div className="row">
      <Avatar user={me.user} />
      <span className="small mono">{me.user.login}</span>
      <form method="post" action="/auth/logout"><button className="btn btn-quiet btn-sm" type="submit"><LogOut className="icon" aria-hidden />Sign out</button></form>
    </div>
  );
}
