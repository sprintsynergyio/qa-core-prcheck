// The comment decision this repo's workflow and the comment command make together.
// The strings are the ones in prcheck.yml and action.yml. The tests fail if those files drift.

export const WORKFLOW_COMMENT_EXPR =
  "github.event.pull_request.head.repo.full_name == github.repository && github.actor != 'dependabot[bot]'";

export const ACTION_COMMENT_IF = "inputs.comment == 'true'";

/**
 * GitHub turns the workflow boolean into the action input string: true becomes 'true', false becomes 'false'.
 * A missing head name is not equal to the repository, so the input is 'false'.
 */
export function workflowCommentInput({ headFullName, repository, actor }) {
  const sameRepo = typeof headFullName === 'string' && headFullName === repository;
  const allowed = sameRepo && actor !== 'dependabot[bot]';
  return allowed ? 'true' : 'false';
}

/** The action step runs only when that input is the string true. */
export function commentStepRuns(commentInput) {
  return commentInput === 'true';
}
