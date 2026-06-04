import { features } from "web-features";
import { Octokit } from "@octokit/rest";
import { throttling } from "@octokit/plugin-throttling";
import dedent from "dedent";

const dryRun = !process.argv.includes("--run");

const pattern = /<!--\s*web-features\s*:\s*([a-z0-9-]+)\s*-->/;

interface IterateIssuesParams {
  owner: string;
  repo: string;
}

async function iterateIssues(octokit: Octokit, params: IterateIssuesParams) {
  const query = `
    query($owner: String!, $repo: String!, $cursor: String) {
      repository(owner: $owner, name: $repo) {
        issues(first: 100, states: OPEN, labels: ["feature"], after: $cursor) {
          nodes {
            id
            number
            title
            body
            createdAt
            url
            labels(first: 10) {
              nodes {
                name
              }
            }
          }
          pageInfo {
            endCursor
            hasNextPage
          }
        }
      }
    }
  `;

  let cursor: string | null = null;
  let hasNextPage = true;
  const issues: any[] = [];

  while (hasNextPage) {
    const result: any = await octokit.graphql(query, { ...params, cursor });
    const connection = result.repository.issues;

    const normalizedNodes = connection.nodes.map((node: any) => {
      return {
        id: node.id,
        number: node.number,
        title: node.title,
        body: node.body,
        html_url: node.url,
        labels: node.labels.nodes.map((l: any) => l.name),
      };
    });

    issues.push(...normalizedNodes);
    cursor = connection.pageInfo.endCursor;
    hasNextPage = connection.pageInfo.hasNextPage;
  }

  return issues;
}

async function main() {
  const ThrottlingOctokit = Octokit.plugin(throttling);

  const octokit = new ThrottlingOctokit({
    auth: process.env.GITHUB_TOKEN,
    log: console,
    throttle: {
      onRateLimit: (retryAfter, options, octokit, retryCount) => {
        octokit.log.warn(
          `Request quota exhausted for request ${options.method} ${options.url}`,
        );
        if (retryCount < 1) {
          octokit.log.info(`Retrying after ${retryAfter} seconds!`);
          return true;
        }
      },
      onSecondaryRateLimit: (retryAfter, options, octokit, retryCount) => {
        octokit.log.warn(
          `SecondaryRateLimit detected for request ${options.method} ${options.url}`,
        );
        if (retryCount < 1) {
          octokit.log.info(`Retrying after ${retryAfter} seconds!`);
          return true;
        }
      },
    },
  });

  const params = {
    owner: "web-platform-dx",
    repo: "developer-signals",
  };

  console.log("Fetching open issues (GraphQL)...");
  const issues = await iterateIssues(octokit, params);
  console.log(`Fetched ${issues.length} open issues.`);

  const featureIssuesMap = new Map<string, any[]>();

  for (const issue of issues) {
    if (typeof issue === "string") {
      continue;
    }

    if (!("body" in issue) || typeof issue.body !== "string") {
      continue;
    }

    const m = pattern.exec(issue.body);
    if (m) {
      let id = m[1];
      if (features[id]?.kind === "moved") {
        id = features[id].redirect_target;
      }

      const list = featureIssuesMap.get(id) || [];
      list.push(issue);
      featureIssuesMap.set(id, list);
    }
  }

  const duplicatesToClose: { dup: any; original: any }[] = [];

  for (const [id, list] of featureIssuesMap.entries()) {
    if (list.length > 1) {
      // Sort issues by number ascending (oldest first)
      const sorted = list.sort((a, b) => a.number - b.number);
      const original = sorted[0];
      const duplicates = sorted.slice(1);

      for (const dup of duplicates) {
        if (dup.labels.includes("duplicate")) {
          duplicatesToClose.push({ dup, original });
        }
      }
    }
  }

  console.log(
    `\nTotal duplicates identified to close: ${duplicatesToClose.length}`,
  );

  if (duplicatesToClose.length === 0) {
    console.log("No duplicate issues to close.");
    return;
  }

  if (dryRun) {
    console.log(
      `\n[DRY RUN] Would comment and close ${duplicatesToClose.length} issues.`,
    );
    console.log("Example comment that would be posted:");
    const sample = duplicatesToClose[0];
    const sampleComment = dedent`
      This issue has been identified as a duplicate of #${sample.original.number}.

      To help consolidate developer signals and upvotes in one place, we are closing this issue. Please head over to #${sample.original.number} to leave any comments or thumbs-up reactions.

      Thank you for your support!
    `;
    console.log("-----------------------------------------");
    console.log(sampleComment);
    console.log("-----------------------------------------");
    console.log("To apply these changes, run the script with the --run flag.");
    return;
  }

  console.log(
    `\nCommenting and closing ${duplicatesToClose.length} duplicate issues in batches...`,
  );
  // We perform 2 mutations (addComment, closeIssue) per issue, so a batch of 10 issues has 20 mutations.
  const batchSize = 1;
  for (let i = 0; i < duplicatesToClose.length; i += batchSize) {
    const batch = duplicatesToClose.slice(i, i + batchSize);
    console.log(
      `Processing batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(
        duplicatesToClose.length / batchSize,
      )} (${batch.length} issues)...`,
    );

    const mutations: string[] = [];
    batch.forEach((item, index) => {
      const commentBody = dedent`
        This issue has been identified as a duplicate of #${item.original.number}.

        To help consolidate developer signals and upvotes in one place, we are closing this issue. Please head over to #${item.original.number} to leave any comments or thumbs-up reactions.

        Thank you for your support!
      `;
      // Escape the comment body for GraphQL
      const escapedComment = JSON.stringify(commentBody);

      mutations.push(
        `comment${index}: addComment(input: {subjectId: "${item.dup.id}", body: ${escapedComment}}) { clientMutationId }`,
      );
      mutations.push(
        `close${index}: closeIssue(input: {issueId: "${item.dup.id}", stateReason: NOT_PLANNED}) { clientMutationId }`,
      );
    });

    const mutationQuery = `
      mutation {
        ${mutations.join("\n")}
      }
    `;

    try {
      await octokit.graphql(mutationQuery);
    } catch (err: any) {
      console.error(`Error executing batch ${Math.floor(i / batchSize) + 1}:`);
      if (err.errors) {
        for (const e of err.errors) {
          console.error(`  - ${e.message} (path: ${e.path?.join(".")})`);
        }
      } else {
        console.error(err);
      }
      throw err;
    }
  }

  console.log("Commenting and closing completed successfully!");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
