# AG-UI agent

A quick example of an AgentCore agent that outputs AG-UI events.

## Usage

Deploy the agent's infrastructure with:

```
./scripts/cdk-deploy.sh
```

Then run it on your own machine with:

```
./scripts/agentcore-inspector.sh
```

See the
[AgentCore CLI wrapper](../../libs/python/agentcore-cli-wrapper/README.md) for
what that needs and what else you can pass it.

The Inspector renders this agent's replies as streaming text, because it
outputs AG-UI events.
