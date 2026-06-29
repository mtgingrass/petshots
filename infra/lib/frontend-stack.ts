import * as cdk from 'aws-cdk-lib/core';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as targets from 'aws-cdk-lib/aws-route53-targets';
import { Construct } from 'constructs';

const DOMAIN = 'petshots.app';
const WWW = `www.${DOMAIN}`;

export class FrontendStack extends cdk.Stack {
  public readonly bucket: s3.Bucket;
  public readonly distribution: cloudfront.Distribution;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Existing hosted zone (registered 2026-06-27). Deterministic lookup by id+name,
    // so no cdk.context.json round-trip on synth.
    const hostedZone = route53.HostedZone.fromHostedZoneAttributes(this, 'HostedZone', {
      hostedZoneId: 'Z09793663K82W8IATJUT',
      zoneName: DOMAIN,
    });

    // Private bucket holding the built React files. No public access; only CloudFront
    // reads it via Origin Access Control (wired below).
    this.bucket = new s3.Bucket(this, 'SiteBucket', {
      bucketName: 'petshots-frontend',
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY, // dev only
      autoDeleteObjects: true, // dev only - empties bucket on stack delete
    });

    // CloudFront only reads certs from us-east-1; this stack is us-east-1, so a plain
    // Certificate works. DNS validation auto-creates the CNAME in the hosted zone.
    const certificate = new acm.Certificate(this, 'Certificate', {
      domainName: DOMAIN,
      subjectAlternativeNames: [WWW],
      validation: acm.CertificateValidation.fromDns(hostedZone),
    });

    this.distribution = new cloudfront.Distribution(this, 'Distribution', {
      defaultRootObject: 'index.html',
      domainNames: [DOMAIN, WWW],
      certificate,
      minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
      defaultBehavior: {
        // withOriginAccessControl: the modern OAC path (replaces legacy OAI). CDK also
        // writes the bucket policy granting this distribution read access.
        origin: origins.S3BucketOrigin.withOriginAccessControl(this.bucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
      },
      // SPA routing: S3 returns 403/404 for client-side routes like /dashboard.
      // Serve index.html with a 200 so React Router can handle the path.
      errorResponses: [
        { httpStatus: 403, responseHttpStatus: 200, responsePagePath: '/index.html' },
        { httpStatus: 404, responseHttpStatus: 200, responsePagePath: '/index.html' },
      ],
    });

    // Point both apex and www at the distribution (A = IPv4, AAAA = IPv6).
    const aliasTarget = route53.RecordTarget.fromAlias(
      new targets.CloudFrontTarget(this.distribution),
    );
    new route53.ARecord(this, 'AliasApex', { zone: hostedZone, target: aliasTarget });
    new route53.AaaaRecord(this, 'AliasApexV6', { zone: hostedZone, target: aliasTarget });
    new route53.ARecord(this, 'AliasWww', {
      zone: hostedZone,
      recordName: 'www',
      target: aliasTarget,
    });
    new route53.AaaaRecord(this, 'AliasWwwV6', {
      zone: hostedZone,
      recordName: 'www',
      target: aliasTarget,
    });

    new cdk.CfnOutput(this, 'BucketName', {
      value: this.bucket.bucketName,
      exportName: 'PetshotsFrontendBucket',
    });
    new cdk.CfnOutput(this, 'DistributionId', {
      value: this.distribution.distributionId,
      exportName: 'PetshotsDistributionId',
    });
    new cdk.CfnOutput(this, 'DistributionDomain', {
      value: this.distribution.distributionDomainName,
      exportName: 'PetshotsDistributionDomain',
    });
  }
}
