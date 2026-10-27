#!/bin/bash
set -eu
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
if [ "${1:-}" != rat-root-mounted ]; then
  mkdir /newroot
  mount --bind / /newroot
  cd /newroot
  mount --move . /
  exec chroot . /init rat-root-mounted
fi
mount -t proc proc /proc
# Resolve the guest's own hostname locally before executor configuration discovery.
printf '%s\n' rat-things-worker > /proc/sys/kernel/hostname
printf '%s\n' rat-things-worker > /etc/hostname
printf '%s\n' '127.0.0.1 localhost rat-things-worker' '::1 localhost rat-things-worker' > /etc/hosts
mount -t sysfs sysfs /sys
mount -t devtmpfs devtmpfs /dev
mkdir -p /dev/pts /dev/shm /run /tmp /workspace /mnt/rat-disk
mount -t devpts devpts /dev/pts
mount -t tmpfs tmpfs /dev/shm
mount -t tmpfs tmpfs /run
mount -t tmpfs tmpfs /tmp
modprobe virtio_pci
modprobe virtio_blk
modprobe virtio_rng
modprobe vmw_vsock_virtio_transport
modprobe ext4
for i in {1..100}; do
  [ -b /dev/vda ] && break
  sleep .1
done
[ -b /dev/vda ]
filesystem=""
for argument in $(cat /proc/cmdline); do
  case "$argument" in rat.filesystem=*) filesystem="${argument#rat.filesystem=}" ;; esac
done
[[ "$filesystem" =~ ^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$ ]]
case " $(cat /proc/cmdline) " in
  *" rat.workspace=fresh "*)
    [ -z "$(blkid -p -s TYPE -o value /dev/vda || true)" ]
    mkfs.ext4 -q -F -m 0 -U "$filesystem" /dev/vda
    mount -t ext4 /dev/vda /mnt/rat-disk
    mkdir /mnt/rat-disk/workspace
    mkdir -m 700 /mnt/rat-disk/state
    ;;
  *" rat.workspace=readonly "*)
    [ "$(blkid -p -s UUID -o value /dev/vda)" = "$filesystem" ]
    header="$(dumpe2fs -h /dev/vda 2>/dev/null)"
    [[ "$header" != *needs_recovery* ]]
    e2fsck -fn /dev/vda >/dev/null 2>&1
    mount -t ext4 -o ro,noload /dev/vda /mnt/rat-disk ;;
  *)
    [ "$(blkid -p -s UUID -o value /dev/vda)" = "$filesystem" ]
    mount -t ext4 /dev/vda /mnt/rat-disk ;;
esac
mount --bind /mnt/rat-disk/workspace /workspace
mkdir -p /var/lib/rat-things/workspace
mount --bind /mnt/rat-disk/state /var/lib/rat-things/workspace
exec python3 /opt/rat-things/native-guest.py
