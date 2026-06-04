import { Octokit } from "@octokit/rest";
import { throttling } from "@octokit/plugin-throttling";

const dryRun = !process.argv.includes("--run");

interface IterateIssuesParams {
  owner: string;
  repo: string;
}

async function iterateIssues(octokit: Octokit, params: IterateIssuesParams) {
  // Query issues that have the "duplicate" label
  const query = `
    query($owner: String!, $repo: String!, $cursor: String) {
      repository(owner: $owner, name: $repo) {
        issues(first: 100, labels: ["duplicate"], after: $cursor) {
          nodes {
            id
            number
            title
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

    const normalizedNodes = connection.nodes
      .filter((node: any) => {
        const names = node.labels.nodes.map((l: any) => l.name);
        return names.includes("feature");
      })
      .map((node: any) => {
        return {
          id: node.id,
          number: node.number,
          title: node.title,
          html_url: node.url,
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

  console.log("Fetching 'feature' label ID...");
  const labelQuery: any = await octokit.graphql(
    `
    query($owner: String!, $repo: String!) {
      repository(owner: $owner, name: $repo) {
        label(name: "feature") {
          id
        }
      }
    }
  `,
    params,
  );

  const featureLabelId = labelQuery.repository.label?.id;
  if (!featureLabelId) {
    console.error("Label 'feature' not found in repository.");
    process.exit(1);
  }
  console.log(`Feature label ID: ${featureLabelId}`);

  console.log(
    "\nFetching issues with both 'feature' and 'duplicate' labels...",
  );
  const issues = await iterateIssues(octokit, params);
  console.log(`Found ${issues.length} issues.`);

  if (issues.length === 0) {
    console.log("No issues found with both labels.");
    return;
  }

  if (dryRun) {
    console.log(
      `\n[DRY RUN] Would remove 'feature' label from ${issues.length} issues.`,
    );
    for (const issue of issues.slice(0, 10)) {
      console.log(`  - #${issue.number} (${issue.html_url})`);
    }
    if (issues.length > 10) {
      console.log(`  ... and ${issues.length - 10} more.`);
    }
    console.log(
      "\nTo apply these changes, run the script with the --run flag.",
    );
    return;
  }

  console.log(
    `\nRemoving 'feature' label from ${issues.length} issues in batches...`,
  );
  const batchSize = 1;
  for (let i = 0; i < issues.length; i += batchSize) {
    const batch = issues.slice(i, i + batchSize);
    console.log(
      `Processing batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(
        issues.length / batchSize,
      )} (${batch.length} issues)...`,
    );

    const mutations = batch.map((issue, index) => {
      return `mut${index}: removeLabelsFromLabelable(input: {labelableId: "${issue.id}", labelIds: ["${featureLabelId}"]}) { clientMutationId }`;
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

  console.log("Removing 'feature' labels completed successfully!");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
