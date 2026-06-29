import * as cdk from 'aws-cdk-lib/core';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as autoscaling from 'aws-cdk-lib/aws-autoscaling';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as rds from 'aws-cdk-lib/aws-rds';
import { Construct } from 'constructs';

interface AppStackProps extends cdk.StackProps {
  vpc: ec2.IVpc;
  cluster: rds.DatabaseCluster;
}

export class AppStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: AppStackProps) {
    super(scope, id, props);

    const { vpc, cluster } = props;

    // EC2 instance role: SSM session access (over the existing NAT - no bastion,
    // no paid interface endpoints) + read the DB master secret from Secrets Manager.
    const instanceRole = new iam.Role(this, 'InstanceRole', {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'),
      ],
    });
    cluster.secret!.grantRead(instanceRole);

    // Placeholder API: install nginx and serve a health page on :80 so the ALB has
    // a healthy target. Real API code replaces this later.
    const userData = ec2.UserData.forLinux();
    userData.addCommands(
      'dnf install -y nginx',
      "echo '<h1>Petshots API - coming soon</h1>' > /usr/share/nginx/html/index.html",
      'systemctl enable --now nginx',
    );

    const asg = new autoscaling.AutoScalingGroup(this, 'Asg', {
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T4G, ec2.InstanceSize.MICRO),
      machineImage: ec2.MachineImage.latestAmazonLinux2023({
        cpuType: ec2.AmazonLinuxCpuType.ARM_64,
      }),
      role: instanceRole,
      userData,
      minCapacity: 1,
      maxCapacity: 2,
    });

    const alb = new elbv2.ApplicationLoadBalancer(this, 'Alb', {
      vpc,
      internetFacing: true,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
    });

    // open: true opens :80 to the internet on the ALB's security group.
    const listener = alb.addListener('Http', { port: 80, open: true });

    // Wiring targets to the ASG auto-creates the SG rule letting the ALB reach
    // the instances on :80 (instance SG accepts only from ALB SG).
    listener.addTargets('AppFleet', {
      port: 80,
      targets: [asg],
      healthCheck: { path: '/', healthyHttpCodes: '200' },
    });

    // Punch :3306 through the DB security group from the app tier only.
    // We create this ingress rule in THIS stack rather than via
    // cluster.connections.allowDefaultPortFrom(asg) - that would attach the rule
    // to DataStack's SG referencing AppStack's SG id, making DataStack depend on
    // AppStack. AppStack already imports DataStack's secret, so every reference
    // must flow AppStack -> DataStack or CloudFormation sees a cycle.
    new ec2.CfnSecurityGroupIngress(this, 'AuroraIngressFromApp', {
      groupId: cluster.connections.securityGroups[0].securityGroupId,
      ipProtocol: 'tcp',
      fromPort: 3306,
      toPort: 3306,
      sourceSecurityGroupId: asg.connections.securityGroups[0].securityGroupId,
      description: 'App tier to Aurora',
    });

    new cdk.CfnOutput(this, 'AlbDnsName', {
      value: alb.loadBalancerDnsName,
      exportName: 'PetshotsAlbDnsName',
    });
  }
}
