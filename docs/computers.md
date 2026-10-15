# Preparing computers

[Back to the README](../README.md)

## SSH and shutdown permissions

Verify the SSH host fingerprint through a trusted console or an already verified
management connection on the target computer. On Linux, for example:

```sh
ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub -E sha256
```

Copy the `SHA256:...` field without a trailing `=`. Check that the server offers
that key. `ssh-keyscan` without independent verification is not a trusted source.
An unknown or changed key prevents the shutdown command from running.

On Linux, the SSH user must be allowed to run the fixed shutdown command without
a password. Use `sudo visudo -f /etc/sudoers.d/lightning` to add a rule such as
this one, replacing the username as needed:

```sudoers
lightning ALL=(root) NOPASSWD: /sbin/shutdown -h now
```

The API runs exactly `sudo -n /sbin/shutdown -h now`. Check that this path exists
on the target. Do not grant broad `NOPASSWD: ALL` permissions or arbitrary command
access. Test actual shutdown during a planned maintenance window.

On Windows, install and configure OpenSSH Server, start `sshd`, allow the chosen
SSH port through the firewall, and grant the SSH user shutdown permissions.
The command is exactly `shutdown.exe /s /t 0`. Verify the offered host key from a
trusted console using `ssh-keygen -lf` on the public host key in
`C:\ProgramData\ssh`. Validate permissions and behavior on the target computer.

## Wake-on-LAN

Enable LAN/PCIe wake in BIOS/UEFI and in the network adapter driver. Check standby
power, wired LAN support, the MAC address, and the subnet broadcast address.
Switches, firewalls, sleep states, and Windows Fast Startup can prevent WOL.
The Docker host and target computers should be on the same LAN; a router must
forward broadcasts if they are on different subnets. A TCP status check does not
prove WOL or shutdown works: both require verification on real hardware.

The broadcast address is not the subnet mask. For example, IP address
`192.168.1.20` with subnet mask `255.255.255.0` has broadcast address
`192.168.1.255`. Use your own subnet's broadcast address and the MAC address of the
adapter that supports WOL. The default UDP port is 9.

A successful WOL response confirms that the API sent the packet; it is not an
acknowledgment from the computer. When troubleshooting, compare the MAC address,
broadcast address, and port with a working WOL app, and check that both senders
can reach the same LAN.
