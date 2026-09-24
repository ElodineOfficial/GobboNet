# GobboNet for Fedora (x86_64)

Install the package with dnf:

    sudo dnf install ./gobbonet-1.7.6-*.fedora.x86_64.rpm

Then run `gobbonet` as yourself (not with sudo), or open GobboNet from the
application menu. The first launch opens the setup wizard in your browser.

Use `dnf`, not `rpm -i`. From Fedora 45, rpm refuses packages that are not
signed, and this one is not; dnf installs a file you name on its command line,
says it skipped the signature check, and fetches anything the package needs.

**Fedora 45 and later.** Fedora moved to OpenSSL 4, and the bundled llama.cpp
engine is built against OpenSSL 3. dnf installs Fedora's compatibility
package, `openssl3-libs`, alongside GobboNet for that reason; there is nothing
to do by hand. On Fedora 43 and 44 the system OpenSSL is version 3 already.

The setup and launch flow matches the Debian package, and so do the Go server
and the llama.cpp b10456 engine: same builds. Program files live under
/usr/lib64/gobbonet. Your configuration, chats and models live in your own
folders (~/.config/gobbonet and ~/.local/share/gobbonet, or the data folder you
chose during setup).

The engine uses the GPU through Vulkan when a Vulkan driver is present --
`vulkan-loader` and `mesa-vulkan-drivers`, which dnf installs by default as
weak dependencies; NVIDIA's proprietary driver brings its own -- and the CPU
otherwise.

For LAN access, allow the chosen TCP port in firewalld on your trusted network
zone. The wizard's command uses the default zone; add `--zone=YOUR_ZONE` if the
trusted network uses another one. Local-only use needs no firewall change. The
package never changes firewalld or SELinux policy. Keep SELinux enabled.

Reference: https://docs.fedoraproject.org/en-US/quick-docs/firewalld/

`gobbonet setup` reruns setup, `gobbonet doctor` provides diagnostics, and
`gobbonet --no-browser` suppresses browser opening. If clicking the icon seems
to do nothing, the reason is in ~/.local/share/gobbonet/launch.log.

**Removing.** `sudo dnf remove gobbonet` removes the program and leaves your
data alone. To clear your data as well, run `gobbonet uninstall` as yourself
first -- it asks about the models separately -- and then remove the package.
(`gobbonet uninstall` currently ends by suggesting `apt remove`; on Fedora the
command is `sudo dnf remove gobbonet`.)

This is an unsigned local RPM for Fedora x86_64. Its dependency resolution,
installation, upgrade from 1.7.3-3, removal and first-run setup were tested
against Fedora 43, 44, 45 and Rawhide. SELinux on a real desktop and GPU
inference on real hardware still need testing on Fedora hardware.
