import * as cdk from 'aws-cdk-lib/core';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaNode from 'aws-cdk-lib/aws-lambda-nodejs';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as events from 'aws-cdk-lib/aws-events';
import * as eventsTargets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import { HttpApi, HttpMethod, CorsHttpMethod } from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import { HttpUserPoolAuthorizer } from 'aws-cdk-lib/aws-apigatewayv2-authorizers';
import { Construct } from 'constructs';
import * as path from 'node:path';
// Product-tunable values (limits, cadences, sizing) — one documented file
// shared with both Lambda bundles, so env values and code fallbacks are
// literally the same constants. Edit values THERE, then `cdk deploy`.
import {
  LIMITS_FREE,
  LIMITS_PAID,
  UPLOADS,
  REMINDERS,
  DAILY_NUDGE,
  DIGEST,
  AI,
  EMAIL,
  INFRA,
} from '../lambda/shared/config';

interface ApiStackProps extends cdk.StackProps {
  userPool: cognito.IUserPool;
  userPoolClient: cognito.IUserPoolClient;
}

// Allowed callers: the live site (apex + www) and the local dev server. Used for
// both the HTTP API CORS preflight and the S3 bucket CORS (direct browser PUT/GET).
const ORIGINS = ['https://petshots.app', 'https://www.petshots.app', 'http://localhost:5173'];

export class ApiStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: ApiStackProps) {
    super(scope, id, props);

    const { userPool, userPoolClient } = props;

    // Private bucket for vaccine docs + pet.json. Browser uploads land here
    // directly via presigned URLs, so it needs a CORS rule.
    const uploads = new s3.Bucket(this, 'UploadsBucket', {
      bucketName: 'petshots-uploads',
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      // Protect uploaded vaccine docs: retain the bucket + contents on destroy.
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      autoDeleteObjects: false,
      cors: [
        {
          // POST: browser uploads now use a presigned POST policy (size-limited).
          allowedMethods: [
            s3.HttpMethods.POST,
            s3.HttpMethods.PUT,
            s3.HttpMethods.GET,
            s3.HttpMethods.HEAD,
          ],
          allowedOrigins: ORIGINS,
          allowedHeaders: ['*'],
          exposedHeaders: ['ETag'],
          maxAge: 3000,
        },
      ],
      lifecycleRules: [
        {
          // AI-extraction uploads sit in tmp/ until the user confirms the
          // review screen; anything abandoned is swept after a day, free.
          id: 'ExpireTmpUploads',
          prefix: 'tmp/',
          expiration: cdk.Duration.days(UPLOADS.TMP_EXPIRY_DAYS),
        },
      ],
    });

    // The single router Lambda. esbuild bundles the AWS SDK + presigner in
    // (externalModules: [] -> don't rely on whatever the runtime happens to ship).
    const apiFn = new lambdaNode.NodejsFunction(this, 'ApiFn', {
      entry: path.join(__dirname, '../lambda/api/index.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      architecture: lambda.Architecture.ARM_64,
      // Sizing rationale documented on INFRA in lambda/shared/config.ts.
      memorySize: INFRA.API_MEMORY_MB,
      timeout: cdk.Duration.seconds(INFRA.API_TIMEOUT_SECONDS),
      environment: {
        UPLOADS_BUCKET: uploads.bucketName,
        // Free-tier caps. A user is paid when users/{sub}/plan.json says so
        // (written by billing tooling/operator only); paid users get PAID_*.
        MAX_PETS: String(LIMITS_FREE.MAX_PETS),
        MAX_DOCS: String(LIMITS_FREE.MAX_DOCS),
        MAX_MEDS: String(LIMITS_FREE.MAX_MEDS), // medications per pet
        PAID_MAX_PETS: String(LIMITS_PAID.MAX_PETS),
        PAID_MAX_DOCS: String(LIMITS_PAID.MAX_DOCS),
        PAID_MAX_MEDS: String(LIMITS_PAID.MAX_MEDS),

        // Family members (besides the owner). Pets stay under the owner's
        // prefix, so the owner's plan governs the shared pool.
        MAX_MEMBERS: String(LIMITS_FREE.MAX_MEMBERS),
        PAID_MAX_MEMBERS: String(LIMITS_PAID.MAX_MEMBERS),

        // Enforced by the S3 POST policy.
        MAX_FILE_BYTES: String(UPLOADS.MAX_FILE_BYTES),

        // AI document extraction (Bedrock). Daily per-user scan caps bound
        // worst-case model spend to pennies per user.
        BEDROCK_MODEL_ID: AI.BEDROCK_MODEL_ID,
        MAX_AI_SCANS: String(LIMITS_FREE.MAX_AI_SCANS_PER_DAY),
        PAID_MAX_AI_SCANS: String(LIMITS_PAID.MAX_AI_SCANS_PER_DAY),

        // Stripe key/webhook-secret/price-ids live in this Secrets Manager
        // secret, maintained by infra/scripts/setup-stripe.mjs.
        STRIPE_SECRET_NAME: 'petshots/stripe',
        APP_URL: EMAIL.APP_URL,

        // DELETE /account removes the caller's own Cognito user (always the
        // verified JWT's sub, never a client-supplied name).
        USER_POOL_ID: userPool.userPoolId,
      },
      bundling: {
        externalModules: [],
        minify: true,
        target: 'node20',
      },
    });

    // The presigned URLs inherit the Lambda role's permissions, so the role must
    // actually be allowed to Get/Put/Delete/List on the bucket.
    uploads.grantReadWrite(apiFn);

    // Explicit wildcard-suffix ARN: importing by name and calling grantRead
    // emits a policy that misses the 6-char random suffix on the real ARN
    // (the session-6 turnstile-secret AccessDenied bug).
    apiFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['secretsmanager:GetSecretValue'],
        resources: [
          `arn:aws:secretsmanager:${this.region}:${this.account}:secret:petshots/stripe-*`,
        ],
      }),
    );

    // AdminDeleteUser: self-service account deletion (only ever the verified
    // JWT's own sub). AdminGetUser: display emails for family invites/joins —
    // the access token carries no email claim.
    apiFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['cognito-idp:AdminDeleteUser', 'cognito-idp:AdminGetUser'],
        resources: [userPool.userPoolArn],
      }),
    );

    // Family invite emails (POST /household/invites with an email address).
    apiFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['ses:SendEmail', 'sesv2:SendEmail'],
        resources: ['*'],
      }),
    );

    // Claude on Bedrock for document extraction. Scoped to Sonnet 4.6;
    // the inference-profile ARN covers the cross-region routing variant.
    // (Model access must also be enabled once in the Bedrock console.)
    apiFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
        resources: [
          'arn:aws:bedrock:*::foundation-model/anthropic.claude-sonnet-4-6*',
          `arn:aws:bedrock:*:${this.account}:inference-profile/*anthropic.claude-sonnet-4-6*`,
        ],
      }),
    );

    // API Gateway verifies the Cognito token before our code runs; the Lambda
    // only ever sees a valid token's claims.
    const authorizer = new HttpUserPoolAuthorizer('CognitoAuthorizer', userPool, {
      userPoolClients: [userPoolClient],
    });

    const httpApi = new HttpApi(this, 'HttpApi', {
      apiName: 'petshots-api',
      corsPreflight: {
        allowOrigins: ORIGINS,
        allowMethods: [
          CorsHttpMethod.GET,
          CorsHttpMethod.POST,
          CorsHttpMethod.PUT,
          CorsHttpMethod.PATCH,
          CorsHttpMethod.DELETE,
          CorsHttpMethod.OPTIONS,
        ],
        allowHeaders: ['authorization', 'content-type'],
        maxAge: cdk.Duration.hours(1),
      },
    });

    const integration = new HttpLambdaIntegration('ApiIntegration', apiFn);

    // Daily reminder Lambda — triggered by EventBridge, not API Gateway.
    const reminderFn = new lambdaNode.NodejsFunction(this, 'ReminderFn', {
      entry: path.join(__dirname, '../lambda/reminder/index.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: INFRA.REMINDER_MEMORY_MB,
      timeout: cdk.Duration.minutes(INFRA.REMINDER_TIMEOUT_MINUTES),
      environment: {
        UPLOADS_BUCKET: uploads.bucketName,
        FROM_EMAIL: EMAIL.FROM_EMAIL,
        APP_URL: EMAIL.APP_URL,
        // Web Push VAPID keypair (private half) — public half ships in the SPA.
        VAPID_SECRET_NAME: 'petshots/vapid',
        // APNs token-auth config for the native iOS app. The secret does not
        // exist yet (needs Mark's Apple Developer account — see IOS.md); the
        // Lambda skips iOS pushes gracefully until it does.
        APNS_SECRET_NAME: 'petshots/apns',
      },
      bundling: { externalModules: [], minify: true, target: 'node20' },
    });
    reminderFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['secretsmanager:GetSecretValue'],
        resources: [
          `arn:aws:secretsmanager:${this.region}:${this.account}:secret:petshots/vapid-*`,
          `arn:aws:secretsmanager:${this.region}:${this.account}:secret:petshots/apns-*`,
        ],
      }),
    );
    // ReadWrite (not just read): the reminder run lazily persists a per-user
    // unsubToken into settings.json for accounts created before unsubscribe
    // links existed.
    uploads.grantReadWrite(reminderFn);
    reminderFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['ses:SendEmail', 'sesv2:SendEmail'],
        resources: ['*'],
      }),
    );

    // Daily run time is set in lambda/shared/config.ts (REMINDERS.CRON_*).
    const dailyRule = new events.Rule(this, 'DailyReminderRule', {
      schedule: events.Schedule.cron({
        minute: String(REMINDERS.CRON_MINUTE),
        hour: String(REMINDERS.CRON_HOUR_UTC),
        day: '*',
        month: '*',
        year: '*',
      }),
      description: 'Fires the Petshots vaccine reminder Lambda once per day',
    });
    dailyRule.addTarget(new eventsTargets.LambdaFunction(reminderFn));

    // Feeding/walk nudge — two more daily hits on the same Lambda, later in
    // the day, distinguished by the { nudge } payload. Times are set in
    // lambda/shared/config.ts (DAILY_NUDGE.*).
    const breakfastNudgeRule = new events.Rule(this, 'BreakfastNudgeRule', {
      schedule: events.Schedule.cron({
        minute: String(DAILY_NUDGE.BREAKFAST_MINUTE),
        hour: String(DAILY_NUDGE.BREAKFAST_HOUR_UTC),
        day: '*',
        month: '*',
        year: '*',
      }),
      description: 'Push-only nudge if breakfast is not checked off yet',
    });
    breakfastNudgeRule.addTarget(
      new eventsTargets.LambdaFunction(reminderFn, {
        event: events.RuleTargetInput.fromObject({ nudge: 'breakfast' }),
      }),
    );

    const eveningNudgeRule = new events.Rule(this, 'EveningNudgeRule', {
      schedule: events.Schedule.cron({
        minute: String(DAILY_NUDGE.EVENING_MINUTE),
        hour: String(DAILY_NUDGE.EVENING_HOUR_UTC),
        day: '*',
        month: '*',
        year: '*',
      }),
      description: 'Push-only nudge if dinner/walk is not checked off yet',
    });
    eveningNudgeRule.addTarget(
      new eventsTargets.LambdaFunction(reminderFn, {
        event: events.RuleTargetInput.fromObject({ nudge: 'evening' }),
      }),
    );

    // Monthly report — a paid-plan perk (mirrors GET /trends's month: null
    // free-tier split), once a month on the same Lambda. Day-of-month is set
    // directly on the cron rule (DIGEST.MONTHLY_REPORT_DAY_UTC in config.ts)
    // rather than firing daily and checking the date inside the handler.
    const monthlyReportRule = new events.Rule(this, 'MonthlyReportRule', {
      schedule: events.Schedule.cron({
        minute: String(DIGEST.MONTHLY_REPORT_MINUTE),
        hour: String(DIGEST.MONTHLY_REPORT_HOUR_UTC),
        day: String(DIGEST.MONTHLY_REPORT_DAY_UTC),
        month: '*',
        year: '*',
      }),
      description: 'Sends the paid-plan monthly report email once a month',
    });
    monthlyReportRule.addTarget(
      new eventsTargets.LambdaFunction(reminderFn, {
        event: events.RuleTargetInput.fromObject({ monthlyReport: true }),
      }),
    );

    const authedRoutes: [HttpMethod, string][] = [
      [HttpMethod.GET, '/pets'],
      [HttpMethod.POST, '/pets'],
      [HttpMethod.GET, '/trends'],
      [HttpMethod.POST, '/trends/send'],
      [HttpMethod.PUT, '/pets/{petId}'],
      [HttpMethod.DELETE, '/pets/{petId}'],
      [HttpMethod.POST, '/pets/{petId}/avatar/upload-url'],
      [HttpMethod.GET, '/pets/{petId}/docs'],
      [HttpMethod.POST, '/pets/{petId}/docs/upload-url'],
      [HttpMethod.POST, '/pets/{petId}/docs/analyze-upload-url'],
      [HttpMethod.POST, '/pets/{petId}/docs/analyze'],
      [HttpMethod.POST, '/pets/{petId}/docs/commit'],
      [HttpMethod.POST, '/pets/{petId}/docs/create-record'],
      [HttpMethod.PATCH, '/pets/{petId}/docs/{id}'],
      [HttpMethod.DELETE, '/pets/{petId}/docs/{id}'],
      [HttpMethod.GET, '/pets/{petId}/meds'],
      [HttpMethod.PUT, '/pets/{petId}/meds'],
      [HttpMethod.GET, '/pets/{petId}/weights'],
      [HttpMethod.POST, '/pets/{petId}/weights'],
      [HttpMethod.DELETE, '/pets/{petId}/weights/{date}'],
      [HttpMethod.GET, '/pets/{petId}/daily'],
      [HttpMethod.POST, '/pets/{petId}/daily/check'],
      [HttpMethod.POST, '/pets/{petId}/daily/mood'],
      [HttpMethod.PUT, '/pets/{petId}/daily/items'],
      [HttpMethod.POST, '/pets/{petId}/passport'],
      [HttpMethod.DELETE, '/pets/{petId}/passport'],
      [HttpMethod.GET, '/settings'],
      [HttpMethod.PUT, '/settings'],
      [HttpMethod.GET, '/roadmap/votes'],
      [HttpMethod.POST, '/roadmap/vote'],
      [HttpMethod.POST, '/push/subscribe'],
      [HttpMethod.POST, '/push/unsubscribe'],
      [HttpMethod.GET, '/household'],
      [HttpMethod.POST, '/household/invites'],
      [HttpMethod.DELETE, '/household/invites/{token}'],
      [HttpMethod.POST, '/household/join'],
      [HttpMethod.DELETE, '/household/members/{memberSub}'],
      [HttpMethod.POST, '/household/leave'],
      [HttpMethod.POST, '/billing/checkout'],
      [HttpMethod.POST, '/billing/portal'],
      [HttpMethod.DELETE, '/account'],
    ];
    for (const [method, routePath] of authedRoutes) {
      httpApi.addRoutes({ path: routePath, methods: [method], integration, authorizer });
    }

    // Public passport endpoint — no Cognito token required; the Lambda checks the
    // passport token's validity itself.
    httpApi.addRoutes({ path: '/passport/{token}', methods: [HttpMethod.GET], integration });

    // Public roadmap — curated items + vote counts; voting itself is authed.
    httpApi.addRoutes({ path: '/roadmap', methods: [HttpMethod.GET], integration });

    // Public invite preview for the /join page (who invited you, is it live) —
    // possession of the unguessable token is the auth, same as passports.
    httpApi.addRoutes({
      path: '/household/invites/{token}',
      methods: [HttpMethod.GET],
      integration,
    });

    // Stripe webhook — server-to-server, authenticated by the webhook signature
    // (verified in the Lambda), so no Cognito authorizer.
    httpApi.addRoutes({ path: '/billing/webhook', methods: [HttpMethod.POST], integration });

    // Unsubscribe-from-all-email — reached from an email link with no login;
    // the Lambda validates the per-user unsubToken itself.
    httpApi.addRoutes({ path: '/unsubscribe', methods: [HttpMethod.POST], integration });

    new cdk.CfnOutput(this, 'ApiUrl', {
      value: httpApi.apiEndpoint,
      exportName: 'PetshotsApiUrl',
    });
    new cdk.CfnOutput(this, 'UploadsBucketName', {
      value: uploads.bucketName,
      exportName: 'PetshotsUploadsBucket',
    });
  }
}
