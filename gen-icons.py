# Generate simple SVG icons and convert to PNG using Python
import struct, zlib, base64

def make_png(size, bg='#D97757', fg='#FFFFFF'):
    """Minimal PNG generator for a simple icon"""
    # We'll create the PNG via HTML canvas approach - just write SVG for now
    pass

# Write SVG icons (Safari/iOS accepts SVG in manifest via PNG fallback)
svg_192 = '''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 192 192" width="192" height="192">
  <rect width="192" height="192" rx="40" fill="#D97757"/>
  <text x="96" y="82" font-family="serif" font-size="52" font-weight="bold" fill="#FFF8F5" text-anchor="middle" dominant-baseline="middle" font-style="italic">my</text>
  <text x="96" y="132" font-family="sans-serif" font-size="28" font-weight="bold" fill="white" text-anchor="middle">Health+</text>
</svg>'''

svg_512 = svg_192.replace('width="192" height="192"', 'width="512" height="512"').replace('viewBox="0 0 192 192"', 'viewBox="0 0 192 192"')

with open('/home/claude/mhp-pwa/icon-192.svg', 'w') as f:
    f.write(svg_192)
with open('/home/claude/mhp-pwa/icon-512.svg', 'w') as f:
    f.write(svg_512)

print("SVG icons written")
