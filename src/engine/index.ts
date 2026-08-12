/**
 * The fighting-game simulation.
 *
 * Nothing in here (except `BoxDebug`, which is opt-in) touches Three.js, the
 * DOM, or the wall clock. Drive it with `Match.step(inputs)` at a fixed 60 Hz
 * and read the fighters for rendering.
 */

export * from './Boxes';
export * from './contract';
export * from './Gauges';
export * from './Physics';
export * from './Motion';
export * from './StateMachine';
export * from './Combat';
export * from './Fighter';
export * from './Match';
export { moveListFor, S } from '../data/moves';
