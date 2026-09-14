#!/usr/bin/env python3
"""
Naming + tag audit for the brief's G1 requirement: every resource must be prefixed
`devops-g<N>-` and carry the tags {group, owner, environment, service, managed-by,
capstone}. Run this against real AWS, don't just eyeball the console.

Uses the AWS Resource Groups Tagging API (covers most taggable services in one paginated
call) plus a couple of resource-type-specific fallbacks for services that API has
historically had gaps for (notably IAM).

Usage:
    python infra/scripts/audit_naming_tags.py [--region eu-west-1] [--prefix devops-g5]

Requires the `aws` CLI to be authenticated in the current shell (whatever profile/session
is already active - this script shells out to `aws`, it doesn't manage credentials itself).
"""

import argparse
import json
import subprocess
import sys

REQUIRED_TAGS = ["group", "owner", "environment", "service", "managed-by", "capstone"]

# Resource types whose ARN/ID is an AWS-assigned opaque identifier (vpc-xxxx, sg-xxxx,
# API Gateway's short IDs, ...) rather than something we chose - for these, the
# naming-prefix check looks at the `Name` tag instead of the ID itself, since the ID can
# never carry our prefix by design.
ID_BASED_TYPES = {
    "ec2:vpc",
    "ec2:subnet",
    "ec2:security-group",
    "ec2:internet-gateway",
    "ec2:natgateway",
    "ec2:elastic-ip",
    "ec2:route-table",
    "ec2:network-interface",
    "kms:key",
    # A listener has no name of its own in AWS's model (no Name property, just an ARN) -
    # check its Name *tag* instead of trying to derive one from the load balancer's name.
    "elasticloadbalancing:listener",
}

# Individual security group RULES (not the groups themselves, which are properly named and
# already checked above) don't have a meaningful "name" to check at all - the brief's own
# naming examples never name anything at the individual-rule level, only at the
# resource level (security groups, roles, buckets, ...). Exempted from the naming check
# entirely rather than forced into an artificial Name tag just to make the audit pass.
NAMING_EXEMPT_TYPES = {
    "ec2:security-group-rule",
}

# Resource types whose ARN nests the actual name inside extra path segments
# (arn:...:loadbalancer/app/<name>/<id>) - the plain "first slash" split used for everything
# else picks the wrong segment for these. Index counts from the start of `segments`
# (segments[0] is the resource type itself, e.g. "loadbalancer").
NESTED_NAME_TYPES = {
    "elasticloadbalancing:loadbalancer": 2,  # ["loadbalancer","app","<name>","<id>"] -> index 2
}


def run_aws(args):
    result = subprocess.run(["aws", *args, "--output", "json"], capture_output=True, text=True)
    if result.returncode != 0:
        print(f"    ! aws {' '.join(args)} failed: {result.stderr.strip()}", file=sys.stderr)
        return None
    return json.loads(result.stdout) if result.stdout.strip() else None


def get_tagged_resources(region, tag_key, tag_value):
    resources = []
    token = None
    while True:
        args = [
            "resourcegroupstaggingapi", "get-resources",
            "--region", region,
            "--tag-filters", f"Key={tag_key},Values={tag_value}",
        ]
        if token:
            args += ["--pagination-token", token]
        page = run_aws(args)
        if page is None:
            break
        resources.extend(page.get("ResourceTagMappingList", []))
        token = page.get("PaginationToken") or None
        if not token:
            break
    return resources


def resource_type_and_name(arn):
    # arn:PARTITION:SERVICE:REGION:ACCOUNT:RESOURCE
    parts = arn.split(":", 5)
    service = parts[2] if len(parts) > 2 else "?"
    resource_part = parts[5] if len(parts) > 5 else ""

    # API Gateway v2 ARNs have an empty ACCOUNT segment (arn:aws:apigateway:region::/apis/x),
    # which is a different shape from everything else here - treat the whole service as
    # ID-based rather than trying to parse a resource type out of it.
    if service == "apigateway":
        return "apigateway:*", resource_part.lstrip("/")

    if "/" in resource_part:
        segments = resource_part.split("/")
        rtype = segments[0]
        full_type = f"{service}:{rtype}"
        # Some ARNs nest the real name a level deeper (loadbalancer/app/<name>/<id>,
        # listener/app/<lb-name>/<lb-id>/<id>) rather than right after the type.
        if full_type in NESTED_NAME_TYPES and len(segments) > NESTED_NAME_TYPES[full_type]:
            name = segments[NESTED_NAME_TYPES[full_type]]
        else:
            name = "/".join(segments[1:])
    elif ":" in resource_part:
        rtype, name = resource_part.split(":", 1)
    else:
        rtype, name = resource_part, resource_part
    return f"{service}:{rtype}", name


def check_resource(arn, tags, prefix):
    rtype, name = resource_type_and_name(arn)
    tag_dict = {t["Key"]: t["Value"] for t in tags}

    missing_tags = [t for t in REQUIRED_TAGS if t not in tag_dict]

    if rtype in NAMING_EXEMPT_TYPES:
        naming_subject = "<naming n/a for this resource type>"
        naming_ok = True
    elif rtype in ID_BASED_TYPES or rtype == "apigateway:*":
        naming_subject = tag_dict.get("Name", "<no Name tag>")
        naming_ok = naming_subject.startswith(prefix)
    else:
        naming_subject = name
        naming_ok = naming_subject.startswith(prefix)

    return {
        "arn": arn,
        "type": rtype,
        "naming_subject": naming_subject,
        "naming_ok": naming_ok,
        "missing_tags": missing_tags,
        "tags_ok": len(missing_tags) == 0,
    }


def check_iam_roles(prefix):
    """Resource Groups Tagging API has had historical gaps for IAM - check directly too."""
    roles = run_aws(["iam", "list-roles"]) or {"Roles": []}
    results = []
    for role in roles.get("Roles", []):
        name = role["RoleName"]
        if not name.startswith(prefix):
            continue
        tags_resp = run_aws(["iam", "list-role-tags", "--role-name", name]) or {"Tags": []}
        tag_dict = {t["Key"]: t["Value"] for t in tags_resp.get("Tags", [])}
        missing = [t for t in REQUIRED_TAGS if t not in tag_dict]
        results.append({
            "arn": role["Arn"],
            "type": "iam:role",
            "naming_subject": name,
            "naming_ok": True,
            "missing_tags": missing,
            "tags_ok": len(missing) == 0,
        })
    return results


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--region", default="eu-west-1")
    parser.add_argument("--prefix", default="devops-g5")
    args = parser.parse_args()

    print(f"Naming + tag audit - region={args.region} prefix={args.prefix}\n")

    resources = get_tagged_resources(args.region, "capstone", "tillflow")
    print(f"Resource Groups Tagging API returned {len(resources)} resources tagged capstone=tillflow.\n")

    results = [check_resource(r["ResourceARN"], r.get("Tags", []), args.prefix) for r in resources]

    seen_arns = {r["arn"] for r in results}
    for iam_result in check_iam_roles(args.prefix):
        if iam_result["arn"] not in seen_arns:
            results.append(iam_result)

    results.sort(key=lambda r: r["type"])

    failures = [r for r in results if not (r["naming_ok"] and r["tags_ok"])]

    print(f"{'TYPE':<24} {'NAME/SUBJECT':<40} {'NAMING':<8} {'TAGS':<8} MISSING")
    print("-" * 100)
    for r in results:
        naming = "ok" if r["naming_ok"] else "FAIL"
        tags = "ok" if r["tags_ok"] else "FAIL"
        missing = ",".join(r["missing_tags"]) if r["missing_tags"] else "-"
        print(f"{r['type']:<24} {r['naming_subject']:<40} {naming:<8} {tags:<8} {missing}")

    print(f"\n{len(results)} resources checked, {len(failures)} failing.")
    if failures:
        print("\nFAILURES:")
        for r in failures:
            print(f"  - {r['arn']}: naming_ok={r['naming_ok']} missing_tags={r['missing_tags']}")
        sys.exit(1)


if __name__ == "__main__":
    main()
