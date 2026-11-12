# The entire durability story for this app's memory and response cache
# lives on this one volume. There is deliberately no auto-scaling group and
# no second instance: the app keeps its state in a local SQLite file
# (lib/db.ts), and a second instance writing to a second, different file
# would just be a second, inconsistent copy of someone's conversation
# history - not more capacity. If this app ever needs to scale out, that
# has to happen by moving the store to Postgres + Redis first (see
# DESIGN.md's "what I'd do with another week"), not by adding instances
# under it.
#
# prevent_destroy means exactly what it says: `terraform destroy` will
# refuse to touch this resource. To actually remove it, delete this
# lifecycle block on purpose, in its own commit, so it's a decision and not
# a `terraform destroy` someone ran without thinking about what's on it.

resource "aws_ebs_volume" "data" {
  availability_zone = local.availability_zone
  size              = var.data_volume_size_gb
  type              = "gp3"
  encrypted         = true

  tags = {
    Project     = var.project
    Environment = var.environment
    Name        = "${var.project}-data"
  }

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_volume_attachment" "data" {
  device_name = "/dev/sdf"
  volume_id   = aws_ebs_volume.data.id
  instance_id = aws_instance.app.id

  # EBS can detach the volume on destroy without refusing outright; the
  # volume resource above is still the one with prevent_destroy, so the
  # data itself is safe even if this attachment is torn down.
  stop_instance_before_detaching = true
}
