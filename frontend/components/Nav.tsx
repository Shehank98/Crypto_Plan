"use client";

import Link from "next/link";
import { useAuth } from "@/lib/auth";

export function Nav() {
  const { user, logout } = useAuth();
  return (
    <header className="border-b border-slate-200 bg-white">
      <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3">
        <Link href="/dashboard" className="flex items-center gap-2 font-semibold text-slate-900">
          <span className="grid h-7 w-7 place-items-center rounded-lg bg-brand text-white">₿</span>
          DCA Planner
        </Link>
        <nav className="flex items-center gap-3 text-sm">
          <Link href="/dashboard" className="text-slate-600 hover:text-slate-900">
            Dashboard
          </Link>
          <Link href="/plans/new" className="text-slate-600 hover:text-slate-900">
            New plan
          </Link>
          {user && (
            <>
              <span className="hidden text-slate-400 sm:inline">{user.email}</span>
              <button onClick={logout} className="btn-secondary py-1.5">
                Log out
              </button>
            </>
          )}
        </nav>
      </div>
    </header>
  );
}
