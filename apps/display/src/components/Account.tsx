import { signIn, signOut, type Session } from "../session.ts";

export function Account({ session }: { session: Session | null }) {
  if (!session) return null;
  const { config, me, anonymous, signedIn } = session;

  if (signedIn) {
    return (
      <div class="account">
        {me && <p class="tag">{me.name}</p>}
        <button type="button" onClick={() => void signOut()}>
          Sign out
        </button>
      </div>
    );
  }

  const login = anonymous ? (config?.signIn ?? null) : null;
  const demo = anonymous && (config?.auth === "demo" || config?.auth === "open");
  if (!demo && !login) return null;
  return (
    <div class="account">
      {demo && <p class="tag">{login ? "Demo" : "Demo · no sign-in"}</p>}
      {login && (
        <button type="button" onClick={() => void signIn(login)}>
          Sign in
        </button>
      )}
    </div>
  );
}
