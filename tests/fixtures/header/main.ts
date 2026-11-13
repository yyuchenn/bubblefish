import { mount } from 'svelte';
import HeaderFixture from './HeaderFixture.svelte';
import '../../../src/styles.css';

mount(HeaderFixture, { target: document.getElementById('app')! });
