"use client";

import { Suspense, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { completeLogin } from "@/lib/oauth";

function Callback() {
  const router = useRouter();
  const params = useSearchParams();
  const [error, setError] = useState<string | null>(null);
  // React 18+ runs effects twice in dev; the code is single-use, so a second
  // exchange would fail against the issuer.
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;

    completeLogin(new URLSearchParams(params.toString()))
      .then((returnTo) => router.replace(returnTo))
      .catch((err: unknown) =>
        setError(err instanceof Error ? err.message : "Sign-in failed."),
      );
  }, [params, router]);

  return (
    <div className="app">
      <div className="empty" style={{ margin: "auto" }}>
        {error ? (
          <>
            <div className="error">{error}</div>
            <div className="examples">
              <button className="chip" onClick={() => router.replace("/")}>
                Back to the chat
              </button>
            </div>
          </>
        ) : (
          <div className="status">
            <span className="dot" />
            Completing sign-in
          </div>
        )}
      </div>
    </div>
  );
}

export default function CallbackPage() {
  // useSearchParams needs a Suspense boundary to prerender.
  return (
    <Suspense fallback={null}>
      <Callback />
    </Suspense>
  );
}
