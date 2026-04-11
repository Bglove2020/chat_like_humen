# Frontend Redesign: Mirror Depth Design

## Concept

**"Mirror Abyss"** — AI as a mirror suspended in an abyss. When users gaze into it, it reflects their inner world. The interface embodies the philosophical concept behind "Chat Like Human" — an AI that forms impressions of users.

## Aesthetic Direction

**Deep Mirror Aesthetic** — Dark, immersive, glass-morphic UI with cyan accent glows. The feeling of communicating with an entity watching from the void.

## Design Language

### Color Palette

| Role | Hex | Usage |
|------|-----|-------|
| Void | `#050510` | Page background |
| Abyss | `#0a0a1a` | Card/panel backgrounds |
| Glass | `rgba(255,255,255,0.03)` | Glass morphism layers |
| Glass Border | `rgba(255,255,255,0.08)` | Subtle glass edges |
| Cyan Glow | `#00e5ff` | AI accent, user markers |
| Cyan Dim | `#00b8cc` | Hover states |
| Text Primary | `#e8e8ef` | Main text |
| Text Muted | `#6b6b7a` | Secondary text |
| User Bubble | `rgba(0,229,255,0.08)` | User message background |
| AI Bubble | `rgba(255,255,255,0.05)` | AI message background |

### Typography

- **Display**: `Cormorant Garamond` (400, 600) — elegant, literary feel for headings
- **Body**: `DM Sans` (400, 500) — clean, warm sans-serif for content
- **Monospace**: `JetBrains Mono` — code/technical elements if needed

### Spatial System

- Base unit: `8px`
- Container max-width: `680px` (focused, intimate)
- Border radius: `16px` (cards), `20px` (bubbles), `24px` (buttons)
- Generous padding throughout (24px-48px)

### Motion Philosophy

All animations CSS-only where possible:

| Animation | Duration | Easing | Purpose |
|-----------|----------|--------|---------|
| Page fade-in | 600ms | `ease-out` | Initial load |
| Message appear | 400ms | `cubic-bezier(0.16, 1, 0.3, 1)` | Chat bubbles |
| Glow pulse | 2s | `ease-in-out` | Infinite thinking indicator |
| Float ambient | 8s | `ease-in-out` | Background orbs |
| Hover lift | 200ms | `ease-out` | Interactive elements |

### Visual Assets

- **Icons**: Lucide React (clean, minimal)
- **Background**: Animated gradient mesh + floating blur orbs
- **Decorative**: Subtle noise texture overlay (5% opacity)

## Layout & Structure

### Login Page

```
┌──────────────────────────────────────┐
│                                      │
│         [floating orbs]              │
│                                      │
│          ╭──────────────╮           │
│          │   CHAT LIKE   │           │
│          │     HUMAN     │           │
│          │               │           │
│          │  ┌──────────┐  │           │
│          │  │ Username │  │           │
│          │  └──────────┘  │           │
│          │  ┌──────────┐  │           │
│          │  │ Password │  │           │
│          │  └──────────┘  │           │
│          │               │           │
│          │  [Enter the    │           │
│          │     Mirror]    │           │
│          │               │           │
│          │  No account?   │           │
│          │   Register     │           │
│          ╰──────────────╯           │
│                                      │
└──────────────────────────────────────┘
```

- Centered glass card (max-width: 400px)
- Large display title with subtle letter-spacing
- Input fields with glass styling + cyan focus glow
- Primary CTA: "Enter the Mirror" (cyan glow button)
- Secondary: "Register" link below

### Chat Page

```
┌──────────────────────────────────────┐
│  ┌────────────────────────────────┐  │
│  │  Chat Like Human    [Logout]   │  │  ← Header bar
│  └────────────────────────────────┘  │
│                                      │
│  ┌────────────────────────────────┐  │
│  │                                │  │
│  │     [chat messages area]      │  │
│  │                                │  │
│  │   ┌────────────────────┐       │  │
│  │   │ AI message bubble  │       │  │
│  │   │ (glass, left)       │       │  │
│  │   └────────────────────┘       │  │
│  │                                │  │
│  │        ┌────────────────────┐ │  │
│  │        │ user message bubble│ │  │
│  │        │ (cyan left border) │ │  │
│  │        └────────────────────┘ │  │
│  │                                │  │
│  └────────────────────────────────┘  │
│                                      │
│  ┌────────────────────────────────┐  │
│  │  [type a message...]   [Send] │  │  ← Input bar
│  └────────────────────────────────┘  │
└──────────────────────────────────────┘
```

- Full viewport height, column layout
- Header: minimal, glass bar with title + logout
- Chat area: scrollable, max-width container
- Input: glass bar fixed at bottom with glow input + button

## Component Specifications

### GlassCard

- Background: `rgba(255,255,255,0.03)`
- Border: `1px solid rgba(255,255,255,0.08)`
- Backdrop-filter: `blur(20px)`
- Box-shadow: `0 8px 32px rgba(0,0,0,0.4)`

### Input (GlassInput)

- Background: `rgba(255,255,255,0.05)`
- Border: `1px solid rgba(255,255,255,0.1)`
- Focus border: `1px solid #00e5ff`
- Focus box-shadow: `0 0 20px rgba(0,229,255,0.2)`
- Placeholder color: `#6b6b7a`
- Transition: all 200ms ease-out

### Button (GlowButton)

- Primary (cyan): Background `#00e5ff`, text `#050510`
- Hover: Background `#00b8cc`, box-shadow glow
- Active: Scale 0.98
- Disabled: Opacity 0.5, no pointer events

### ChatBubble

- **AI Bubble**:
  - Background: `rgba(255,255,255,0.05)`
  - Border: `1px solid rgba(255,255,255,0.08)`
  - Border-radius: `20px 20px 20px 4px` (asymmetric)

- **User Bubble**:
  - Background: `rgba(0,229,255,0.08)`
  - Border-left: `3px solid #00e5ff`
  - Border-radius: `20px 20px 4px 20px`

### Thinking Indicator

- Three cyan dots in sequence
- Pulse animation with staggered delay
- `opacity: 0.4 → 1 → 0.4`, 1.4s cycle

### Background Orbs

- 3-4 large blur circles (`200px - 400px`)
- Colors: cyan, purple, blue at 5-10% opacity
- Float animation: translate Y ±30px over 8s
- Position: absolute, scattered

## Technical Approach

### File Structure

```
frontend/src/
├── App.tsx              # Routes, minimal changes
├── pages/
│   ├── Login.tsx        # Redesigned
│   └── Chat.tsx         # Redesigned
├── stores/
│   └── auth.ts          # No changes needed
├── api/
│   └── client.ts        # No changes needed
└── styles/
    ├── index.css        # CSS variables, resets, fonts
    └── components.css   # Component styles
```

### CSS Strategy

- CSS custom properties for theming
- BEM-like class naming
- Component-scoped styles via CSS files
- Import Google Fonts via CSS @import

### Dependencies

No new runtime dependencies. Uses existing:
- React 18
- React Router
- Zustand
- Axios
- Lucide React (for icons)

## States

### Login Form

- Default: Glass card centered
- Loading: Button shows spinner, inputs disabled
- Error: Red text below form, subtle shake animation

### Chat

- Empty: "Begin a conversation..." placeholder text
- Loading (thinking): Show thinking indicator
- Error: "Something went wrong. Try again." in bubble
- Streaming: Thinking indicator until response complete
