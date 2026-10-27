import { appCredentialsFromEnv, identityAudience, identityDirectory, identityPrincipals, type AudienceLookup, type CallerWorkspace, type DirectorySearch } from '@augur/service-kit';

/** What Mandate asks identity: who someone stands for, people and teams by name, and who is on a team. */
export interface People {
  /** Who someone stands for: `person:`, `team:` and `tree:` principals, and `org`. */
  principals: (person: string, workspace: CallerWorkspace) => Promise<string[]>;
  directory: DirectorySearch;
  audience: AudienceLookup;
}

/**
 * Asks identity, as Mandate (the `people:read` scope), or, with no IDENTITY_URL
 * or sign-in as under `pnpm dev:app`, makes do with who is calling: they stand
 * for themselves, the team they're on now and the org; nobody can be found by
 * name and no team is told.
 */
export const peopleFromEnv = (env = process.env): People => {
  const credentials = appCredentialsFromEnv('mandate', env);
  const identityUrl = env.IDENTITY_URL;
  if (!identityUrl || !credentials)
    return {
      principals: async (person, workspace) => [`person:${person}`, ...(workspace.kind === 'team' ? [`team:${workspace.id}`, `tree:${workspace.id}`] : []), 'org'],
      directory: async () => ({ people: [], teams: [] }),
      audience: async () => [],
    };
  const lookup = identityPrincipals({ identityUrl, credentials });
  return { principals: (person) => lookup(person), directory: identityDirectory({ identityUrl, credentials }), audience: identityAudience({ identityUrl, credentials }) };
};

/** The principal a floor lets in: `person:<id>` for someone's own, `tree:<team>` for a team and the teams below it, `org`. */
export const floorPrincipal = (workspace: { id: string; kind: 'personal' | 'team' | 'org' }, person: string) =>
  workspace.kind === 'personal' ? `person:${person}` : workspace.kind === 'org' ? 'org' : `tree:${workspace.id}`;
