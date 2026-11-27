/**
 * Workspace roles, from least to most privileged. Each role includes the
 * permissions of the roles before it.
 *
 * - viewer:     read timelines, incidents, repositories and members
 * - maintainer: also connect repositories, replay fixtures and review checks
 * - owner:      also manage members and their roles
 */
export const WORKSPACE_ROLES = ["viewer", "maintainer", "owner"] as const;
export type WorkspaceRole = (typeof WORKSPACE_ROLES)[number];

export function hasRole(actual: WorkspaceRole, required: WorkspaceRole): boolean {
  return WORKSPACE_ROLES.indexOf(actual) >= WORKSPACE_ROLES.indexOf(required);
}
