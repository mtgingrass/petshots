# Petshots

> Pet health records you can actually find when you need them — built on AWS.

A small SaaS for pet owners: store vaccination records, medication schedules, and (eventually) generate a shareable "pet passport" URL for groomers, sitters, and boarding facilities.

## The problem

> The main reason is for bringing my dog to a new dog bar or doggie day care (can work for cats, too). I'm always scrambling to find his shot records. I end up asking Claude to search my gmail for rabies records. Kind of a pain. I'm trying to eliminate that pain for people.

When your lived workaround is *asking an LLM to grep Gmail for a PDF at the dog-bar door*, the product opportunity is concrete. Existing apps (Great Pet Care, VitusVet, PetDesk) tend to be bloated, vet-centric, or insurance-upsell vehicles. Petshots leads with the **last-mile retrieval moment**: you're at the front desk, the staff is waiting, you need the rabies cert on your phone in ten seconds.

## What it does (MVP)

Free tier, no payments wired up yet — the limits exist so the data model and authz patterns are in place from day one.

- Public landing page
- Sign up with email verification + login (AWS Cognito)
- Simple dashboard
- Upload + label vaccination documents (PDF, JPG) to S3
- Limits: 1 pet per account, 4 documents per pet

**Founder-pain solve in v1:** open the dashboard at the door, show the PDF on your phone. No shareable URL needed *yet*.

## Roadmap (v1.1+)

- Shareable passport URLs (signed-token pattern with short expiry + revocation)
- Vaccine/medication reminders (SES + EventBridge)
- Multi-pet households
- Higher limits + paid tier (Stripe)
- A better dashboard

## Stack

AWS-native, deployed with the CDK in TypeScript. Choices lean toward services with SAA-C03 exam overlap because the project doubles as hands-on prep.

| Layer | Service |
|---|---|
| DNS / domain | Route 53 (`petshots.app`) |
| Auth | Cognito User Pool (sign-up, login, JWT) |
| Frontend | React (Vite + TS) on S3 + CloudFront |
| Backend compute | EC2 + ALB + Auto Scaling Group (Path B, traditional) |
| Database | RDS Aurora MySQL, Multi-AZ |
| File storage | S3 |
| Email | Cognito built-in (MVP); SES later for reminders |
| Payments | Stripe (post-MVP) |
| IaC | AWS CDK (TypeScript) |

Some choices are deliberately dev-flavored to keep monthly cost down during the build — most visibly the **NAT instance** in place of the production-default NAT Gateway (`~$3/mo` vs `~$33/mo`), upgradable with a one-character config change before launch.

## Status

| Layer | Status |
|---|---|
| Domain registered (`petshots.app`) | ✓ |
| AWS account hygiene (MFA, $25 budget alert) | ✓ |
| CDK app initialized + bootstrapped (`us-east-1`) | ✓ |
| **NetworkStack** — VPC, 6 subnets across 2 AZs, NAT instance, hardened SG | ✓ |
| NetworkStack — VPC endpoints (S3 Gateway, SSM Interface) | in progress |
| DataStack — RDS, subnet groups | pending |
| AuthStack — Cognito User Pool | pending |
| ComputeStack — ALB, ASG, EC2 launch template | pending |
| FrontendStack — S3, CloudFront, Route 53 records | pending |
| App code (frontend + backend) | pending |

This is a live build doc, not a retroactive case study — the repo's commit history is the actual sequence of decisions, mistakes, and fixes.

## Deploying it yourself

### Prerequisites

- AWS account with admin or equivalent IAM permissions
- AWS CLI configured locally (`aws configure` or SSO)
- Node.js 18+ and npm
- A region pinned to `us-east-1` (the code currently hardcodes this; multi-region is a later refactor)

### Steps

```bash
# 1. Clone and install dependencies
git clone https://github.com/<your-handle>/petshots.git
cd petshots/infra
npm install

# 2. One-time CDK bootstrap (per account + region)
npx cdk bootstrap aws://<your-account-id>/us-east-1

# 3. Synthesize and review the CloudFormation that'll be deployed
npx cdk synth

# 4. Diff against any currently-deployed version (will show "adding all" on first run)
npx cdk diff

# 5. Deploy
npx cdk deploy
```

Before deploying, **update the account ID** in `infra/bin/infra.ts` to your own AWS account. The code is currently pinned to the author's account for reproducibility.

### Estimated monthly cost (dev)

| | Cost |
|---|---|
| VPC, subnets, route tables, IGW | $0 |
| NAT instance (`t4g.nano`) | ~$3.50 |
| Route 53 hosted zone | $0.50 |
| EBS storage attached to NAT | ~$0.30 |
| **Total before adding RDS / EC2 app tier** | **~$4/mo** |

To stop the meter: `npx cdk destroy PetshotsNetworkStack` removes everything cleanly.

## Notes

- **Why NAT instance, not NAT Gateway?** SAA-C03 covers both as a cost/HA tradeoff. The instance pattern is the dev choice ($3/mo, no built-in HA); a one-line config change flips to NAT Gateway when the app is real.
- **Why one NAT across both AZs?** Same tradeoff. `natGateways: 2` would give us per-AZ HA at ~$6/mo (instances) or ~$66/mo (gateways).
- **Why hardcoded AMI ID for fck-nat?** CDK's `MachineImage.lookup()` runs at synth time and was failing intermittently against the fck-nat AMI publisher account. Hardcoding the resolved ID is reproducible and works without a network round-trip during synth. When fck-nat publishes a new version, the ID gets bumped manually.

## License

MIT.
