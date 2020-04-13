import React from "react";
import Auth from "@aws-amplify/auth";
import pems from "../pems.json";
import { getCognitoCookieInfo } from "./cognito";
import { IncomingMessage } from "http";
import jwt, { TokenExpiredError } from "jsonwebtoken";
import base64 from "base-64";

export const AUTH_SYNC_KEY = "auth_sync_key";

export type IdTokenData = {
  sub: string;
  aud: string;
  email_verified: boolean;
  event_id: string;
  token_use: "id";
  auth_time: number;
  iss: string;
  "cognito:username": string;
  exp: number;
  iat: number;
  email: string;
};

export type AccessTokenData = {
  sub: string;
  event_id: string;
  token_use: string;
  scope: string;
  auth_time: number;
  iss: string;
  exp: number;
  iat: number;
  jti: string;
  client_id: string;
  username: string;
};

export type AuthTokens = {
  accessTokenData: AccessTokenData;
  idTokenData: IdTokenData;
  idToken: string;
  accessToken: string;
} | null;

type AWSCognitoPublicPem = {
  kid: string;
  pem: string;
};

function findMatchingPem(
  pems: AWSCognitoPublicPem[],
  token: string
): AWSCognitoPublicPem | undefined {
  if (!token) return undefined;
  const header = JSON.parse(base64.decode(token.split(".")[0]));
  return pems.find((pem) => pem.kid === header.kid);
}

function verifyToken<T extends { sub: string }>({
  pems,
  token,
  compare,
}: {
  pems: AWSCognitoPublicPem[];
  token: string | null;
  compare: { key: string; value: string };
}): null | T {
  if (!token) return null;
  try {
    const pemEntry = findMatchingPem(pems, token);
    if (!pemEntry) return null;
    const pem = pemEntry.pem;
    const data = jwt.verify(token, pem, { algorithms: ["RS256"] }) as T;
    if (data[compare.key] !== compare.value) return null;
    return data;
  } catch (e) {
    if (!(e instanceof TokenExpiredError)) {
      console.log(e);
    }
    return null;
  }
}

function getAuthFromCookies(cookie?: string): AuthTokens {
  if (!cookie) return null;

  const { idToken, accessToken } = getCognitoCookieInfo(
    cookie,
    process.env.USER_POOL_CLIENT_ID!
  );

  if (!idToken || !accessToken) return null;

  const idTokenData = verifyToken<IdTokenData>({
    pems,
    token: idToken,
    compare: {
      key: "aud",
      value: process.env.USER_POOL_CLIENT_ID!,
    },
  });
  const accessTokenData = verifyToken<AccessTokenData>({
    pems,
    token: accessToken,
    compare: {
      key: "client_id",
      value: process.env.USER_POOL_CLIENT_ID!,
    },
  });

  if (!idTokenData || !accessTokenData) return null;

  return { accessTokenData, idTokenData, idToken, accessToken };
}

export function getServerSideAuth(req: IncomingMessage): AuthTokens {
  return getAuthFromCookies(req.headers.cookie);
}

// auto-login in case loginsub cookie has been added
// TODO instead, autologin when LastUser exists, and an idToken for LastUser
// exists?
function useAutoLogin(auth: AuthTokens) {
  // check on window activation
  React.useEffect(() => {
    // use localStorage to sync auth state across tabs
    const storageListener = (event: StorageEvent) => {
      // When event is unrelated, or when sync key was cleared
      if (event.key !== AUTH_SYNC_KEY || event.newValue === null) return;

      // clear localStorage item since we only needed it to sync across tabs
      localStorage.removeItem(AUTH_SYNC_KEY);

      console.log(
        "triggering recheck from storageListener because of",
        event.newValue
      );

      const { idToken } = getCognitoCookieInfo(
        document.cookie,
        process.env.USER_POOL_CLIENT_ID!
      );

      // login when user was not signed in before, or when the idToken changed
      if (idToken && (!auth || auth.idToken !== idToken)) {
        // do not log in on the token page since we could be loading
        // the cookies currently
        const pathname = window.location.pathname;
        if (pathname === "/token" || pathname.startsWith("/token/")) return;

        window.location.reload();
      }
    };

    // check on write to localStorage
    window.addEventListener("storage", storageListener);
    return () => {
      window.removeEventListener("storage", storageListener);
    };
  }, [auth]);
}

function useAutoLogout(auth: AuthTokens) {
  const isAuthenticated = Boolean(auth);

  // auto-logout in case loginsub cookie has been removed
  React.useEffect(() => {
    const listener = () => {
      const { idToken } = getCognitoCookieInfo(
        document.cookie,
        process.env.USER_POOL_CLIENT_ID!
      );

      // User signed out locally, but server-side props still contain cookies.
      // This means the user signed out through a different tab.
      if (!idToken && isAuthenticated) {
        // do not log out on the token page since we could be loading
        // the cookies currently
        const pathname = window.location.pathname;
        if (pathname === "/token" || pathname.startsWith("/token/")) return;

        if (idToken) {
          // user signed out through another another application, so sign
          // user out completely to remove all auth cookies
          console.log("signing out by deleting loginsub cookie");
          const redirectAfterSignOut = window.location.href;
          // Reconfigure oauth to add the uri of the page which should open
          // after the sign out
          //
          // Calling Auth.configure with null returns the current config
          const config = Auth.configure(null);
          Auth.configure({ oauth: { ...config.oauth, redirectAfterSignOut } });
          Auth.signOut();
        } else {
          // user signed out through another tab, so reload to
          // refresh server-side props
          console.log("signing out by removing all auth cookies");
          window.location.reload();
        }
      }
    };

    window.addEventListener("focus", listener);
    // check on write to localStorage
    window.addEventListener("storage", listener);
    return () => {
      window.removeEventListener("focus", listener);
      window.removeEventListener("storage", listener);
    };
  }, [isAuthenticated]);
}

type LoginFunction = (redirectAfterSignIn?: string) => void;
type LogoutFunction = () => void;

// TODO sync this across multiple invocations?
// If you are using server-side rendering, pass "initialAuth" to this hook.
// If you are using static rendering, pass "null” to this hook.
//
// This hook is expected to be only called once per page at the moment.
// Pass the auth-state down to components using props if they need it.
export function useAuth(initialAuth: AuthTokens): AuthTokens {
  const [auth, setAuth] = React.useState<AuthTokens>(initialAuth);

  useAutoLogin(auth);
  useAutoLogout(auth);

  React.useEffect(() => {
    // When there is a cookie, this takes ~100ms since it's verifying the cookie
    // When we decode only, it goes down to ~5ms.
    //
    // To speed up the client-side renders, we could decode only on the client.
    // But we'd probably need to verify the timestamp anyhow?
    //
    // Note that getAuthFromCookies also runs on the server, so improvements
    // can not have caching-problems.
    const cookieAuth = getAuthFromCookies(document.cookie);
    setAuth(cookieAuth);
  }, []);

  return auth;
}

export function useAuthFunctions() {
  const login: LoginFunction = React.useCallback((redirectAfterSignInUrl) => {
    const defaultRedirectUrl =
      window.location.pathname + window.location.search + window.location.hash;
    const config = Auth.configure(null);
    const redirectAfterSignIn = redirectAfterSignInUrl || defaultRedirectUrl;
    Auth.configure({ oauth: { ...config.oauth, redirectAfterSignIn } });
    Auth.federatedSignIn();
  }, []);

  const logout: LogoutFunction = React.useCallback(() => {
    Auth.signOut().then(() => {
      localStorage.setItem(AUTH_SYNC_KEY, "logout");
    });
  }, []);

  return { login, logout };
}