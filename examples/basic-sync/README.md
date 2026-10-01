# Basic sync example

Two-way sync between two local directories (useful for testing).

```bash
mkdir -p /tmp/duet-a /tmp/duet-b
echo "hello" > /tmp/duet-a/test.txt

# Terminal 1: watch /tmp/duet-a, sync to /tmp/duet-b via localhost SSH
synx /tmp/duet-a localhost:/tmp/duet-b
```

Edit files in either directory — changes propagate both ways.
