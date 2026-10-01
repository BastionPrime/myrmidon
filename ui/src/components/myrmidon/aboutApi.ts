// myrmidon(ABOUT): About surface API: GET /api/myrmidon/about.
import { api } from "@/api/client";

export interface AboutLinks {
  repo: string;
  changelog: string;
  docs: string;
}

export interface AboutInfo {
  product: string;
  version: string;
  commit: string | null;
  buildDate: string | null;
  basePaperclipVersion: string | null;
  imageDigest: string | null;
  license: string;
  links: AboutLinks;
}

export const aboutQueryKey = ["myrmidon", "about"] as const;

export const aboutApi = {
  get: () => api.get<AboutInfo>("/myrmidon/about"),
};
