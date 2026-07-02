import * as cdk from 'aws-cdk-lib/core';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaNode from 'aws-cdk-lib/aws-lambda-nodejs';
import * as cognito from 'aws-cdk-lib/aws-cognito';
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
        MAX_DOCS: '4',
        MAX_FILE_BYTES: String(10 * 1024 * 1024), // 10 MB - enforced by the POST policy
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

    const routes: [HttpMethod, string][] = [
      [HttpMethod.GET, '/pet'],
      [HttpMethod.PUT, '/pet'],
      [HttpMethod.GET, '/docs'],
      [HttpMethod.POST, '/docs/upload-url'],
      [HttpMethod.PATCH, '/docs/{id}'],
      [HttpMethod.DELETE, '/docs/{id}'],
    ];
    for (const [method, routePath] of routes) {
      httpApi.addRoutes({ path: routePath, methods: [method], integration, authorizer });
    }

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
