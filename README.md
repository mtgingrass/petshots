# Petshots

> Pet health records you can actually find when you need them — live at [petshots.app](https://petshots.app), serverless on AWS.

A SaaS for pet owners: store vaccination records and documents, get expiry reminders by email, and share a QR "pet passport" URL that lets a groomer, sitter, or dog bar verify shots from a link — no account required, expiring and revocable.

## The problem

> The main reason is for bringing my dog to a new dog bar or doggie day care (can work for cats, too). I'm always scrambling to find his shot records. I end up asking Claude to search my gmail for rabies records. Kind of a pain. I'm trying to eliminate that pain for people.

When your lived workaround is *asking an LLM to grep Gmail for a PDF at the dog-bar door*, the product opportunity is concrete. Existing apps (Great Pet Care, VitusVet, PetDesk) tend to be bloated, vet-centric, or insurance-upsell vehicles. Petshots leads with the **last-mile retrieval moment**: you're at the front desk, the staff is waiting, you need the rabies cert on your phone in ten seconds.

## What it does (shipped)

- Sign up with email verification + login (Cognito), bot signups blocked by Cloudflare Turnstile at the PreSignUp trigger
- Dashboard for pets and their documents (PDF, JPG) — uploads go straight from the browser to S3 via size-limited presigned POST
- **Pet passports**: shareable QR/URL that shows vaccination status publicly, with token expiry and revocation
- Daily vaccine-expiry reminder emails (EventBridge cron → Lambda → SES)
- Free-tier limits (3 pets, 4 documents each) so the data model and authz patterns support a paid tier later

## Architecture

Fully serverless, deployed with AWS CDK (TypeScript). Source of truth is `infra/lib/*.ts`.

| Layer | Implementation |
|---|---|
| Frontend | React (Vite + TS) SPA, private S3 bucket + CloudFront with Origin Access Control, ACM, Route 53 apex + www, IPv4 + IPv6 |
| Auth | Cognito User Pool; PreSignUp Lambda verifies Cloudflare Turnstile (secret in Secrets Manager); SES domain identity |
| API | API Gateway HTTP API + Cognito JWT authorizer → single router Lambda (Node 20, ARM64, esbuild) — 15 routes, including public `GET /passport/{token}` |
| Data | No database server: pet metadata lives as JSON objects in S3 under per-user prefixes; documents via presigned POST/GET |
| Scheduled jobs | EventBridge daily cron → reminder Lambda → SES |
| IaC | AWS CDK (TypeScript), user-data buckets set to `RemovalPolicy.RETAIN` |

### Design decisions

- **Serverless over three-tier.** The repo also contains the classic path — VPC + NAT + Aurora Serverless v2 + EC2 ASG behind an ALB (`network-stack`, `data-stack`, `app-stack`) — built first as hands-on SAA-C03 prep. The production call went serverless: near-zero idle cost, nothing to patch. The legacy stacks remain in the CDK app as a record of the trade-off.
- **S3 as the database.** At this access pattern (read/write a user's `pet.json` by key), object storage beats running DynamoDB or RDS. The migration path exists if access patterns outgrow it.
- **Authorization at the gateway.** Cognito JWTs are verified by API Gateway, so unauthenticated requests never invoke the Lambda. The one public route (`/passport/{token}`) validates its own signed tokens with expiry + revocation.
- **Uploads bypass the API.** Browsers upload directly to S3 with a presigned POST policy that enforces size limits — file bytes never transit API Gateway or Lambda.
- **NAT instance over NAT Gateway** (legacy stacks): fck-nat at ~$3/mo vs ~$33/mo, the classic SAA cost/HA trade-off, flippable with a one-line change.
- **`RemovalPolicy.RETAIN` on user data** — no stack operation can destroy customer records.

## Deploying it yourself

### Prerequisites

- AWS account with admin or equivalent IAM permissions
- AWS CLI configured locally (`aws configure` or SSO)
- Node.js 20+ and npm
- Region pinned to `us-east-1` (currently hardcoded)

### Steps

```bash
# 1. Clone and install dependencies
git clone https://github.com/mtgingrass/petshots.git
cd petshots/infra
npm install

# 2. One-time CDK bootstrap (per account + region)
npx cdk bootstrap aws://<your-account-id>/us-east-1

# 3. Synthesize and review, then deploy the serverless stacks
npx cdk synth
npx cdk deploy PetshotsAuthStack PetshotsFrontendStack PetshotsApiStack
```

Before deploying, **update the account ID** in `infra/bin/infra.ts`, and expect to swap in your own domain, hosted zone, and Turnstile secret. The legacy `PetshotsNetworkStack` / `PetshotsDataStack` / `PetshotsAppStack` are optional — deploy them only if you want the three-tier variant (they cost real money; Aurora scales to zero, the NAT instance and EC2 do not).

## History

This started as a live build doc for a traditional three-tier architecture and pivoted to serverless partway through — the commit history is the actual sequence of decisions, mistakes, and fixes, not a retroactive case study.

## License

[PolyForm Noncommercial 1.0.0](./LICENSE.md) — read it, run it, learn from it,
modify it, use it for any noncommercial purpose. Commercial use (including
offering this software, or a derivative, as a paid service) is not licensed.

The **Petshots** name, logo, and the petshots.app service are not covered by
the code license — they identify the live product and stay with its owner.

Want to use it commercially anyway? Open an issue — happy to talk.
