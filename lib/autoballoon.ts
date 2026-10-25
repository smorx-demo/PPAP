/**
 * Server-side client for the AutoBalloon service (autoballoon-service/, a
 * FastAPI app vendored from smorx-demo/Autoballooning-with-versions). PPAP
 * calls it as one service account (AUTOBALLOON_USERNAME / _PASSWORD), so
 * PPAP users never see the service's own login; access control is PPAP's
 * (see app/api/ppap/[id]/autoballoon/[...path]/route.ts).
 */

const baseUrl = () => (process.env.AUTOBALLOON_URL || "http://127.0.0.1:9686").replace(/\/$/, "");

let cachedToken: string | null = null;

async function login(): Promise<string> {
  const username = process.env.AUTOBALLOON_USERNAME;
  const password = process.env.AUTOBALLOON_PASSWORD;
  if (!username || !password) {
    throw new AutoballoonUnavailableError("AUTOBALLOON_USERNAME / AUTOBALLOON_PASSWORD are not set in .env.");
  }
  let res: Response;
  try {
    res = await fetch(`${baseUrl()}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
      cache: "no-store",
    });
  } catch {
    throw new AutoballoonUnavailableError(
      `The AutoBalloon service is not running at ${baseUrl()}. Start it with autoballoon-service\\start-ppap.bat.`,
    );
  }
  if (!res.ok) throw new AutoballoonUnavailableError(`AutoBalloon service login failed (${res.status}). Check AUTOBALLOON_USERNAME / _PASSWORD.`);
  const { token } = (await res.json()) as { token: string };
  cachedToken = token;
  return token;
}

export class AutoballoonUnavailableError extends Error {}

/**
 * Calls the service with the service account's token, logging in again once
 * if the cached token was rejected (service restarted / token expired).
 */
export async function autoballoonFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const send = async (token: string) => {
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${token}`);
    try {
      return await fetch(`${baseUrl()}${path}`, { ...init, headers, cache: "no-store", redirect: "manual" });
    } catch {
      throw new AutoballoonUnavailableError(
        `The AutoBalloon service is not running at ${baseUrl()}. Start it with autoballoon-service\\start-ppap.bat.`,
      );
    }
  };
  let res = await send(cachedToken ?? (await login()));
  if (res.status === 401) res = await send(await login());
  return res;
}

/** The subset of a job's inspection-report row PPAP uses. */
export type AutoballoonReportRow = {
  sno: number;
  balloon: number;
  reference?: string;
  nominal?: string;
  tol_low?: string;
  tol_high?: string;
  instrument?: string;
  unit?: string;
  remarks?: string;
  page?: number;
};

export type AutoballoonJob = {
  id: string;
  balloons?: { balloon: number; page: number; text: string }[];
  report_rows?: AutoballoonReportRow[];
};

export async function getAutoballoonJob(jobId: string): Promise<AutoballoonJob> {
  const res = await autoballoonFetch(`/api/jobs/${encodeURIComponent(jobId)}`);
  if (!res.ok) throw new Error(`Could not load the inspection report from the AutoBalloon service (${res.status}).`);
  return (await res.json()) as AutoballoonJob;
}
