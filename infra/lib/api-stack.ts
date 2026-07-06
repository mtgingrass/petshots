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
    });

    // The single router Lambda. esbuild bundles the AWS SDK + presigner in
    // (externalModules: [] -> don't rely on whatever the runtime happens to ship).
    const apiFn = new lambdaNode.NodejsFunction(this, 'ApiFn', {
      entry: path.join(__dirname, '../lambda/api/index.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 256,
      timeout: cdk.Duration.seconds(10),
      environment: {
        UPLOADS_BUCKET: uploads.bucketName,
        // Free-tier caps. A user is paid when users/{sub}/plan.json says so
        // (written by billing tooling/operator only); paid users get PAID_*.
        MAX_PETS: '2',
        MAX_DOCS: '4',
        MAX_MEDS: '4', // medications per pet
        PAID_MAX_PETS: '10',
        PAID_MAX_DOCS: '20',
        PAID_MAX_MEDS: '20',

        MAX_FILE_BYTES: String(20 * 1024 * 1024), // 20 MB - enforced by the POST policy
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
      memorySize: 256,
      timeout: cdk.Duration.minutes(5),
      environment: {
        UPLOADS_BUCKET: uploads.bucketName,
        FROM_EMAIL: 'no-reply@petshots.app',
        APP_URL: 'https://petshots.app',
      },
      bundling: { externalModules: [], minify: true, target: 'node20' },
    });
    uploads.grantRead(reminderFn);
    reminderFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['ses:SendEmail', 'sesv2:SendEmail'],
        resources: ['*'],
      }),
    );

    // Runs at 9:00 AM UTC daily (5am Eastern in summer, 4am in winter).
    const dailyRule = new events.Rule(this, 'DailyReminderRule', {
      schedule: events.Schedule.cron({ minute: '0', hour: '9', day: '*', month: '*', year: '*' }),
      description: 'Fires the Petshots vaccine reminder Lambda once per day',
    });
    dailyRule.addTarget(new eventsTargets.LambdaFunction(reminderFn));

    const authedRoutes: [HttpMethod, string][] = [
      [HttpMethod.GET, '/pets'],
      [HttpMethod.POST, '/pets'],
      [HttpMethod.PUT, '/pets/{petId}'],
      [HttpMethod.DELETE, '/pets/{petId}'],
      [HttpMethod.POST, '/pets/{petId}/avatar/upload-url'],
      [HttpMethod.GET, '/pets/{petId}/docs'],
      [HttpMethod.POST, '/pets/{petId}/docs/upload-url'],
      [HttpMethod.PATCH, '/pets/{petId}/docs/{id}'],
      [HttpMethod.POST, '/pets/{petId}/docs/{id}/update-url'],
      [HttpMethod.DELETE, '/pets/{petId}/docs/{id}'],
      [HttpMethod.GET, '/pets/{petId}/meds'],
      [HttpMethod.PUT, '/pets/{petId}/meds'],
      [HttpMethod.POST, '/pets/{petId}/passport'],
      [HttpMethod.DELETE, '/pets/{petId}/passport'],
      [HttpMethod.GET, '/settings'],
      [HttpMethod.PUT, '/settings'],
    ];
    for (const [method, routePath] of authedRoutes) {
      httpApi.addRoutes({ path: routePath, methods: [method], integration, authorizer });
    }

    // Public passport endpoint — no Cognito token required; the Lambda checks the
    // passport token's validity itself.
    httpApi.addRoutes({ path: '/passport/{token}', methods: [HttpMethod.GET], integration });

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
