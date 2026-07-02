import * as cdk from 'aws-cdk-lib/core';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as ses from 'aws-cdk-lib/aws-ses';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaNode from 'aws-cdk-lib/aws-lambda-nodejs';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';
import * as path from 'node:path';

const DOMAIN = 'petshots.app';
const FROM_EMAIL = `no-reply@${DOMAIN}`;

export class AuthStack extends cdk.Stack {
  // Exposed so other stacks (e.g. ApiStack's JWT authorizer) can reference the
  // pool/client directly via bin/infra.ts props instead of importing exports.
  public readonly userPool: cognito.UserPool;
  public readonly userPoolClient: cognito.UserPoolClient;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // SES domain identity for sending verification/reset emails. easyDKIM auto-
    // creates the DKIM CNAME records in the hosted zone; SES verifies via DNS.
    // The account is still in the SES SANDBOX, so mail only goes to addresses
    // we've explicitly verified - no public blast radius until we request
    // production access.
    const hostedZone = route53.HostedZone.fromHostedZoneAttributes(this, 'HostedZone', {
      hostedZoneId: 'Z09793663K82W8IATJUT',
      zoneName: DOMAIN,
    });
    new ses.EmailIdentity(this, 'DomainIdentity', {
      identity: ses.Identity.publicHostedZone(hostedZone),
    });

    // PreSignUp trigger: verifies the Cloudflare Turnstile token before a
    // self-service signup is allowed. The secret value lives in Secrets Manager
    // (created out-of-band: `petshots/turnstile-secret`) - currently the public
    // Turnstile TEST secret; swap the real value in before SES production.
    // Import by COMPLETE ARN (incl. the random -RS5ju3 suffix), not by name:
    // fromSecretNameV2's partial ARN makes grantRead emit a policy for
    // `...turnstile-secret-??????`, which the suffix-less ARN the Lambda calls
    // with does not match -> AccessDenied on GetSecretValue.
    const turnstileSecret = secretsmanager.Secret.fromSecretCompleteArn(
      this,
      'TurnstileSecret',
      'arn:aws:secretsmanager:us-east-1:462857379184:secret:petshots/turnstile-secret-RS5ju3',
    );
    const preSignUpFn = new lambdaNode.NodejsFunction(this, 'PreSignUpFn', {
      entry: path.join(__dirname, '../lambda/presignup/index.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 256,
      timeout: cdk.Duration.seconds(10),
      environment: { TURNSTILE_SECRET_ARN: turnstileSecret.secretArn },
      bundling: { externalModules: [], minify: true, target: 'node20' },
    });
    turnstileSecret.grantRead(preSignUpFn);

    const userPool = new cognito.UserPool(this, 'UserPool', {
      lambdaTriggers: { preSignUp: preSignUpFn },
      userPoolName: 'petshots-users',
      selfSignUpEnabled: true,
      signInAliases: { email: true },
      autoVerify: { email: true },
      standardAttributes: {
        email: { required: true, mutable: false },
      },
      passwordPolicy: {
        minLength: 8,
        requireLowercase: true,
        requireUppercase: true,
        requireDigits: true,
        requireSymbols: true,
      },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      // Send via our SES domain instead of Cognito's flaky default sender.
      // In-place update of the pool's email config - does not replace the pool,
      // so the pool id (baked into the SPA) is preserved.
      email: cognito.UserPoolEmail.withSES({
        fromEmail: FROM_EMAIL,
        fromName: 'Petshots',
        sesVerifiedDomain: DOMAIN,
        sesRegion: 'us-east-1',
      }),
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    this.userPool = userPool;

    const userPoolClient = userPool.addClient('WebClient', {
      userPoolClientName: 'petshots-web',
      authFlows: {
        userSrp: true,
      },
      preventUserExistenceErrors: true,
    });
    this.userPoolClient = userPoolClient;

    new cdk.CfnOutput(this, 'UserPoolId', {
      value: userPool.userPoolId,
      exportName: 'PetshotsUserPoolId',
    });

    new cdk.CfnOutput(this, 'UserPoolClientId', {
      value: userPoolClient.userPoolClientId,
      exportName: 'PetshotsUserPoolClientId',
    });
  }
}
