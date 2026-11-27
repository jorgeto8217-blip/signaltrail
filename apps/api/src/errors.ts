/** An error that maps directly to an HTTP response with a stable error code. */
export class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    /** Extra machine-readable context, sent as `error.details`. */
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export const unauthorized = () => new HttpError(401, "unauthorized", "A valid API token is required.");

/**
 * Non-members get the same answer as for a workspace that does not exist, so
 * workspace IDs cannot be probed from another tenant.
 */
export const workspaceNotFound = () => new HttpError(404, "workspace_not_found", "Workspace not found.");

export const forbidden = (required: string) =>
  new HttpError(403, "forbidden", `This action requires the ${required} role.`);

export const invalidRequest = (issues: unknown) =>
  new HttpError(400, "invalid_request", "The request is invalid.", { issues });

export const userNotFound = () => new HttpError(404, "user_not_found", "No user with that email.");

export const memberNotFound = () => new HttpError(404, "member_not_found", "Member not found.");

export const alreadyMember = () =>
  new HttpError(409, "already_member", "That user is already a member of this workspace.");

export const lastOwner = () =>
  new HttpError(409, "last_owner", "A workspace must keep at least one owner.");

export const repositoryNotFound = () => new HttpError(404, "repository_not_found", "Repository not found.");

export const repositoryExists = () =>
  new HttpError(409, "repository_exists", "This repository is already connected to the workspace.");
