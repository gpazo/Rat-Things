// SPDX-License-Identifier: GPL-2.0
#include <linux/bpf.h>
#include <bpf/bpf_endian.h>
#include <bpf/bpf_helpers.h>

#define AGENT_UID 10001
#define CONTROL_PORT 8080

struct ipv6_key {
  __u32 words[4];
};

struct {
  __uint(type, BPF_MAP_TYPE_HASH);
  __uint(max_entries, 64);
  __type(key, __u32);
  __type(value, __u8);
} local_v4 SEC(".maps");

struct {
  __uint(type, BPF_MAP_TYPE_HASH);
  __uint(max_entries, 64);
  __type(key, struct ipv6_key);
  __type(value, __u8);
} local_v6 SEC(".maps");

static __always_inline int is_agent_control_connection(struct bpf_sock_addr *ctx)
{
  __u32 uid = (__u32)bpf_get_current_uid_gid();
  return uid == AGENT_UID && bpf_ntohs((__u16)ctx->user_port) == CONTROL_PORT;
}

SEC("cgroup/connect4")
int rat_deny4(struct bpf_sock_addr *ctx)
{
  if (!is_agent_control_connection(ctx))
    return 1;

  __u32 address = ctx->user_ip4;
  __u32 host_address = bpf_ntohl(address);
  if (host_address == 0 || (host_address >> 24) == 127)
    return 0;

  return bpf_map_lookup_elem(&local_v4, &address) ? 0 : 1;
}

SEC("cgroup/connect6")
int rat_deny6(struct bpf_sock_addr *ctx)
{
  if (!is_agent_control_connection(ctx))
    return 1;

  struct ipv6_key key = {
    .words = {
      ctx->user_ip6[0],
      ctx->user_ip6[1],
      ctx->user_ip6[2],
      ctx->user_ip6[3],
    },
  };
  if (key.words[0] == 0 && key.words[1] == 0 && key.words[2] == 0 &&
      key.words[3] == bpf_htonl(1))
    return 0;

  return bpf_map_lookup_elem(&local_v6, &key) ? 0 : 1;
}

char LICENSE[] SEC("license") = "GPL";
