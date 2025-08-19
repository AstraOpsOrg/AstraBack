#!/usr/bin/env bash
set -euo pipefail

has_cmd() { command -v "$1" >/dev/null 2>&1; }

install_terraform() {
    ver="$(curl -s https://checkpoint-api.hashicorp.com/v1/check/terraform | sed -n 's/.*"current_version":"\([^"]*\)".*/\1/p')"
    : "${ver:=1.12.2}"
    curl -fsSL -o /tmp/terraform.zip "https://releases.hashicorp.com/terraform/${ver}/terraform_${ver}_linux_amd64.zip"
    unzip -o /tmp/terraform.zip -d /usr/local/bin >/dev/null
    chmod +x /usr/local/bin/terraform
    rm -f /tmp/terraform.zip
}

install_kubectl() {
    ver="$(curl -Ls https://dl.k8s.io/release/stable.txt)"
    curl -fsSLo /usr/local/bin/kubectl "https://dl.k8s.io/release/${ver}/bin/linux/amd64/kubectl"
    chmod +x /usr/local/bin/kubectl
}

install_awscli() {
    curl -fsSLo /tmp/awscliv2.zip "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip"
    unzip -oq /tmp/awscliv2.zip -d /tmp
    /tmp/aws/install
    rm -rf /tmp/aws /tmp/awscliv2.zip
}

ensure() {
    name="$1"; cmd="$2"; installer="$3"; version_cmd="$4"
    if ! has_cmd "$cmd"; then
        echo "Installing $name..."
        $installer
    fi
    sh -lc "$version_cmd" || true
}

install_helm() {
    ver="$(curl -s https://api.github.com/repos/helm/helm/releases/latest | sed -n 's/.*"tag_name":"\(v[^"\n]*\)".*/\1/p')"
    : "${ver:=v3.15.2}"
    curl -fsSLo /tmp/helm.tar.gz "https://get.helm.sh/helm-${ver}-linux-amd64.tar.gz"
    tar -C /tmp -xzf /tmp/helm.tar.gz
    mv /tmp/linux-amd64/helm /usr/local/bin/helm
    chmod +x /usr/local/bin/helm
    rm -rf /tmp/linux-amd64 /tmp/helm.tar.gz
}

echo "Verifying CLI dependencies (terraform, kubectl, awscli, helm)..."

ensure "Terraform" terraform install_terraform "terraform version | head -n1"
ensure "kubectl" kubectl install_kubectl "kubectl version --client --short 2>/dev/null || kubectl version --client 2>/dev/null || echo 'kubectl installed'"
ensure "AWS CLI" aws install_awscli "aws --version | head -n1"
ensure "Helm" helm install_helm "helm version --short 2>/dev/null || helm version 2>/dev/null || echo 'helm installed'"

echo "All CLI dependencies are available."
