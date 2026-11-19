# Kubernetes cheatsheet

Get pods in all namespaces:

```sh
kubectl get pods --all-namespaces -o wide
kubectl logs -f deployment/api --since=10m
```

Restart a rollout with `kubectl rollout restart deployment/web`.
