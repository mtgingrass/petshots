#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib/core';
import { NetworkStack } from '../lib/network-stack';

const app = new cdk.App();

const env = {
  account: '462857379184',
  region: 'us-east-1',
};

new NetworkStack(app, 'PetshotsNetworkStack', { env });
