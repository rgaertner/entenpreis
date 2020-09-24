import route53 = require("@aws-cdk/aws-route53");
import cdk = require("@aws-cdk/core");
import eks = require("@aws-cdk/aws-eks");
import iam = require("@aws-cdk/aws-iam");
import autoscaling = require("@aws-cdk/aws-autoscaling");
import ec2 = require("@aws-cdk/aws-ec2");
import { Tags } from "@aws-cdk/core";
import { ManagedPolicy } from "@aws-cdk/aws-iam";
import { HelmChart } from "@aws-cdk/aws-eks";

export interface AutoScalerProps {
  readonly instanceType?: string;
  readonly minCapacity?: number;
  readonly k8nVersion?: string;
  readonly autoscalerVersion?: string;
  readonly autoscalerNamespace?: string;
}

export function autoscaler(
  stack: cdk.Stack,
  eksCluster: eks.Cluster,
  props: AutoScalerProps
) {
  const workerRole = new iam.Role(
    stack,
    `EKSWorkerRole-${eksCluster.clusterName}`,
    {
      assumedBy: new iam.ServicePrincipal("ec2.amazonaws.com"),
    }
  );
  workerRole.addManagedPolicy(
    ManagedPolicy.fromAwsManagedPolicyName("AdministratorAccess")
  );
  const onDemandASG = new autoscaling.AutoScalingGroup(
    stack,
    `OnDemandASG-${eksCluster.clusterName}`,
    {
      vpc: eksCluster.vpc,
      role: workerRole,
      minCapacity: props.minCapacity || 1,
      maxCapacity: 10,
      instanceType: new ec2.InstanceType(props.instanceType || "t3.medium"),
      machineImage: new eks.EksOptimizedImage({
        kubernetesVersion: props.k8nVersion || "1.17",
        nodeType: eks.NodeType.STANDARD, // without this, incorrect SSM parameter for AMI is resolved
      }),
      updateType: autoscaling.UpdateType.ROLLING_UPDATE,
    }
  );

  Tags.of(onDemandASG).add(
    `k8s.io/cluster-autoscaler/${eksCluster.clusterName}`,
    "owned",
    {
      applyToLaunchedInstances: true,
    }
  );
  Tags.of(onDemandASG).add("k8s.io/cluster-autoscaler/enabled", "owned", {
    applyToLaunchedInstances: true,
  });
  eksCluster.addAutoScalingGroup(onDemandASG, {});

  const autoscalerNS = props.autoscalerNamespace || "kuber";
  const kuberNS = eksCluster.addManifest(autoscalerNS, {
    apiVersion: "v1",
    kind: "Namespace",
    metadata: { name: autoscalerNS },
  });
  const kuberAdmin = eksCluster.addServiceAccount(
    `${autoscalerNS}-${eksCluster.clusterName}`,
    {
      name: autoscalerNS,
      namespace: autoscalerNS,
    }
  );
  kuberAdmin.node.addDependency(kuberNS);

  kuberAdmin.role.addManagedPolicy(
    ManagedPolicy.fromAwsManagedPolicyName("AdministratorAccess")
  );
  eksCluster.addManifest("kuber-cluster-role-binding", {
    apiVersion: "rbac.authorization.k8s.io/v1beta1",
    kind: "ClusterRoleBinding",
    metadata: {
      name: "kuber-cluster-role-binding",
    },
    roleRef: {
      apiGroup: "rbac.authorization.k8s.io",
      kind: "ClusterRole",
      name: "cluster-admin",
    },
    subjects: [
      {
        kind: "ServiceAccount",
        name: kuberAdmin.serviceAccountName,
        namespace: kuberAdmin.serviceAccountNamespace,
      },
    ],
  });

  new HelmChart(stack, "autoscaler", {
    cluster: eksCluster,
    release: "autoscaler",
    namespace: kuberAdmin.serviceAccountNamespace,
    chart: "cluster-autoscaler-chart",
    repository: "https://kubernetes.github.io/autoscaler",
    version: props.autoscalerVersion || "1.0.1",
    values: {
      awsRegion: stack.region,
      autoDiscovery: {
        clusterName: eksCluster.clusterName,
      },
      rbac: {
        serviceAccount: {
          create: false,
          name: kuberAdmin.serviceAccountName,
        },
      },
    },
  });
  return onDemandASG;
}