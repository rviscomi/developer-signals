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
            reactionGroups {
              content
              users {
                totalCount
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
      const upvoteGroup = node.reactionGroups?.find(
        (g: any) => g.content === "THUMBS_UP",
      );
      const upvotes = upvoteGroup ? upvoteGroup.users.totalCount : 0;
      return {
        id: node.id,
        number: node.number,
        title: node.title,
        body: node.body,
        html_url: node.url,
        labels: node.labels.nodes.map((l: any) => l.name),
        reactions: {
          "+1": upvotes,
        },
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

  console.log("Fetching 'duplicate' label ID...");
  const labelQuery: any = await octokit.graphql(
    `
    query($owner: String!, $repo: String!) {
      repository(owner: $owner, name: $repo) {
        label(name: "duplicate") {
          id
        }
      }
    }
  `,
    params,
  );

  let duplicateLabelId = labelQuery.repository.label?.id;

  if (!duplicateLabelId) {
    console.log("Label 'duplicate' not found. Creating it...");
    await octokit.rest.issues.createLabel({
      ...params,
      name: "duplicate",
      color: "cfd3d7",
      description: "This issue or pull request already exists",
    });

    // Retrieve it again to get the GraphQL node ID
    const labelQueryRetry: any = await octokit.graphql(
      `
      query($owner: String!, $repo: String!) {
        repository(owner: $owner, name: $repo) {
          label(name: "duplicate") {
            id
          }
        }
      }
    `,
      params,
    );
    duplicateLabelId = labelQueryRetry.repository.label?.id;
  }
  console.log(`Duplicate label ID: ${duplicateLabelId}`);

  console.log("\nFetching open issues (GraphQL)...");
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

  const duplicatesToLabel: any[] = [];

  for (const [id, list] of featureIssuesMap.entries()) {
    if (list.length > 1) {
      // Sort issues by number ascending (oldest first)
      const sorted = list.sort((a, b) => a.number - b.number);
      const original = sorted[0];
      const duplicates = sorted.slice(1);

      console.log(`\nFeature: ${id}`);
      console.log(`  Original: #${original.number} (${original.html_url})`);

      for (const dup of duplicates) {
        const commentsCount = dup.comments || 0;
        const reactionsCount = dup.reactions?.["+1"] || 0;
        if (dup.labels.includes("duplicate")) {
          console.log(
            `  Duplicate: #${dup.number} (${dup.html_url}) [Comments: ${commentsCount}, Reactions (+1): ${reactionsCount}] (already labeled duplicate, skipping)`,
          );
          continue;
        }
        console.log(
          `  Duplicate: #${dup.number} (${dup.html_url}) [Comments: ${commentsCount}, Reactions (+1): ${reactionsCount}]`,
        );
        duplicatesToLabel.push(dup);
      }
    }
  }

  console.log(`\nTotal duplicate issues found: ${duplicatesToLabel.length}`);

  if (duplicatesToLabel.length === 0) {
    return;
  }

  if (dryRun) {
    console.log(
      `\n[DRY RUN] Would label ${duplicatesToLabel.length} issues as duplicate.`,
    );
    console.log("To apply these changes, run the script with the --run flag.");
    return;
  }

  console.log(
    `\nLabeling ${duplicatesToLabel.length} duplicate issues in batches...`,
  );
  const batchSize = 10;
  for (let i = 0; i < duplicatesToLabel.length; i += batchSize) {
    const batch = duplicatesToLabel.slice(i, i + batchSize);
    console.log(
      `Processing batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(
        duplicatesToLabel.length / batchSize,
      )} (${batch.length} issues)...`,
    );

    const mutations = batch.map((dup, index) => {
      return `mut${index}: addLabelsToLabelable(input: {labelableId: "${dup.id}", labelIds: ["${duplicateLabelId}"]}) { clientMutationId }`;
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

  console.log("Labeling completed successfully!");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
