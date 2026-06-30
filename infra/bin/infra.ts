#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib/core';
import { NetworkStack } from '../lib/network-stack';
import { AuthStack } from '../lib/auth-stack';
import { DataStack } from '../lib/data-stack';
import { FrontendStack } from '../lib/frontend-stack';
import { AppStack } from '../lib/app-stack';
import { ApiStack } from '../lib/api-stack';

const app = new cdk.App();

const env = {
  account: '462857379184',
  region: 'us-east-1',
};

const network = new NetworkStack(app, 'PetshotsNetworkStack', { env });
const auth = new AuthStack(app, 'PetshotsAuthStack', { env });
const data = new DataStack(app, 'PetshotsDataStack', { env, vpc: network.vpc });
new FrontendStack(app, 'PetshotsFrontendStack', { env });
new AppStack(app, 'PetshotsAppStack', { env, vpc: network.vpc, cluster: data.cluster });
new ApiStack(app, 'PetshotsApiStack', {
  env,
  userPool: auth.userPool,
  userPoolClient: auth.userPoolClient,
});
